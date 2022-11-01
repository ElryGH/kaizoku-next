import { TRPCError } from '@trpc/server';
import path from 'path';
import { z } from 'zod';
import { isCronValid, sanitizer } from '../../../utils';
import { checkChaptersQueue, removeJob, schedule } from '../../queue/checkChapters';
import { downloadQueue, downloadWorker, removeDownloadJobs } from '../../queue/download';
import {
  bindTitleToAnilistId,
  getAvailableSources,
  getMangaDetail,
  Manga,
  removeManga,
  search,
} from '../../utils/mangal';
import { t } from '../trpc';

export const mangaRouter = t.router({
  query: t.procedure.query(async ({ ctx }) => {
    return ctx.prisma.manga.findMany({ include: { metadata: true, library: true }, orderBy: { title: 'asc' } });
  }),
  sources: t.procedure.query(async () => {
    return getAvailableSources();
  }),
  bind: t.procedure
    .input(
      z.object({
        title: z.string().trim().min(1),
        anilistId: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const { title, anilistId } = input;
      await bindTitleToAnilistId(title, anilistId);
    }),
  detail: t.procedure
    .input(
      z.object({
        source: z.string().trim().min(1),
        title: z.string().trim().min(1),
      }),
    )
    .query(async ({ input }) => {
      const { title, source } = input;
      return getMangaDetail(source, title);
    }),
  get: t.procedure
    .input(
      z.object({
        id: z.number(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { id } = input;
      return ctx.prisma.manga.findUniqueOrThrow({
        include: {
          chapters: {
            orderBy: {
              index: 'desc',
            },
          },
          library: true,
          metadata: true,
        },
        where: { id },
      });
    }),
  search: t.procedure
    .input(
      z.object({
        keyword: z.string().trim().min(1),
        source: z.string().trim().min(1),
      }),
    )
    .query(async ({ input }) => {
      const { keyword, source } = input;
      const result = await search(source, keyword);
      return result.Manga.map((m) => ({
        status: m.Metadata.Status,
        title: m.Name,
        cover: m.Metadata.Cover,
      })).filter((m) => !!m.title);
    }),
  remove: t.procedure
    .input(
      z.object({
        id: z.number(),
        shouldRemoveFiles: z.boolean(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, shouldRemoveFiles } = input;
      await downloadWorker.pause(true);
      const removed = await ctx.prisma.manga.delete({
        include: {
          library: true,
          chapters: true,
        },
        where: {
          id,
        },
      });
      await ctx.prisma.metadata.delete({
        where: {
          id: removed.metadataId,
        },
      });
      await removeJob(removed.title);
      await removeDownloadJobs(removed);
      if (shouldRemoveFiles === true) {
        const mangaPath = path.resolve(removed.library.path, sanitizer(removed.title));
        await removeManga(mangaPath);
      }
      downloadWorker.resume();
    }),
  add: t.procedure
    .input(
      z.object({
        source: z.string().trim().min(1),
        title: z.string().trim().min(1),
        interval: z
          .string()
          .trim()
          .min(1)
          .refine((value) => isCronValid(value), {
            message: 'Invalid interval',
          }),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { source, title, interval } = input;
      const mangaDetail: Manga | undefined = await getMangaDetail(source, title);
      const library = await ctx.prisma.library.findFirst();
      if (!mangaDetail || !library) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Cannot find the ${title}.`,
        });
      }
      const result = await ctx.prisma.manga.findFirst({
        where: {
          title,
        },
      });
      if (result) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `${title} already exists in the library.`,
        });
      }

      if (mangaDetail.Name !== title) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `${title} does not match the found manga.`,
        });
      }

      const manga = await ctx.prisma.manga.create({
        include: {
          library: true,
          metadata: true,
        },
        data: {
          source,
          title: mangaDetail.Name,
          library: {
            connect: {
              id: library.id,
            },
          },
          interval,
          metadata: {
            create: {
              cover: mangaDetail.Metadata.Cover,
              authors: mangaDetail.Metadata.Author ? [mangaDetail.Metadata.Author] : [],
              characters: mangaDetail.Metadata.Characters,
              genres: mangaDetail.Metadata.Genres,
              startDate: mangaDetail.Metadata.StartDate
                ? new Date(
                    mangaDetail.Metadata.StartDate.Year,
                    mangaDetail.Metadata.StartDate.Month,
                    mangaDetail.Metadata.StartDate.Day,
                  )
                : undefined,
              endDate: mangaDetail.Metadata.EndDate
                ? new Date(
                    mangaDetail.Metadata.EndDate.Year,
                    mangaDetail.Metadata.EndDate.Month,
                    mangaDetail.Metadata.EndDate.Day,
                  )
                : undefined,
              status: mangaDetail.Metadata.Status,
              summary: mangaDetail.Metadata.Summary,
              synonyms: mangaDetail.Metadata.Synonyms,
              tags: mangaDetail.Metadata.Tags,
              urls: mangaDetail.Metadata.URLs,
            },
          },
        },
      });

      schedule(manga, true);

      return manga;
    }),
  update: t.procedure
    .input(
      z.object({
        id: z.number(),
        interval: z
          .string()
          .trim()
          .min(1)
          .refine((value) => isCronValid(value), {
            message: 'Invalid interval',
          }),
        anilistId: z.string().nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, interval, anilistId } = input;
      const mangaInDb = await ctx.prisma.manga.findUniqueOrThrow({
        where: { id },
      });

      if (anilistId) {
        await bindTitleToAnilistId(mangaInDb.title, anilistId);
      }

      const mangaDetail: Manga | undefined = await getMangaDetail(mangaInDb.source, mangaInDb.title);
      if (!mangaDetail) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Cannot find the metadata for ${mangaInDb.title}.`,
        });
      }

      await ctx.prisma.metadata.update({
        where: {
          id: mangaInDb.metadataId,
        },
        data: {
          cover: mangaDetail.Metadata.Cover,
          authors: mangaDetail.Metadata.Author ? [mangaDetail.Metadata.Author] : [],
          characters: mangaDetail.Metadata.Characters,
          genres: mangaDetail.Metadata.Genres,
          startDate: mangaDetail.Metadata.StartDate
            ? new Date(
                mangaDetail.Metadata.StartDate.Year,
                mangaDetail.Metadata.StartDate.Month,
                mangaDetail.Metadata.StartDate.Day,
              )
            : undefined,
          endDate: mangaDetail.Metadata.EndDate
            ? new Date(
                mangaDetail.Metadata.EndDate.Year,
                mangaDetail.Metadata.EndDate.Month,
                mangaDetail.Metadata.EndDate.Day,
              )
            : undefined,
          status: mangaDetail.Metadata.Status,
          summary: mangaDetail.Metadata.Summary,
          synonyms: mangaDetail.Metadata.Synonyms,
          tags: mangaDetail.Metadata.Tags,
          urls: mangaDetail.Metadata.URLs,
        },
      });

      if (interval !== mangaInDb.interval) {
        const updatedManga = await ctx.prisma.manga.update({
          include: { library: true, metadata: true },
          where: { id },
          data: {
            interval,
          },
        });
        await schedule(updatedManga, false);
      }

      return ctx.prisma.manga.findUniqueOrThrow({ include: { metadata: true, library: true }, where: { id } });
    }),
  history: t.procedure.query(async ({ ctx }) => {
    return ctx.prisma.chapter.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      take: 50,
      include: {
        manga: {
          include: {
            metadata: true,
          },
        },
      },
    });
  }),
  activity: t.procedure.query(async () => {
    return {
      active: await downloadQueue.getActiveCount(),
      queued: await downloadQueue.getWaitingCount(),
      scheduled: await checkChaptersQueue.getDelayedCount(),
      failed: await downloadQueue.getFailedCount(),
      completed: await downloadQueue.getCompletedCount(),
    };
  }),
});
