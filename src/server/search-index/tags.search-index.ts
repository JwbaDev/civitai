import { client } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { EnqueuedTask } from 'meilisearch';
import {
  createSearchIndexUpdateProcessor,
  SearchIndexRunContext,
} from '~/server/search-index/base.search-index';
import { MetricTimeframe } from '@prisma/client';

const READ_BATCH_SIZE = 100;
const INDEX_NAME = 'tags';
const onIndexSetup = async () => {
  if (!client) {
    return;
  }

  const index = await getOrCreateIndex(INDEX_NAME);
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const updateSearchableAttributesTask = await index.updateSearchableAttributes(['name']);

  console.log(
    'onIndexSetup :: updateSearchableAttributesTask created',
    updateSearchableAttributesTask
  );

  const sortableFieldsAttributesTask = await index.updateSortableAttributes([
    'creation_date',
    'metrics.postCount',
    'metrics.articleCount',
    'metrics.followerCount',
    'metrics.modelCount',
    'metrics.imageCount',
    'metrics.hiddenCount',
  ]);

  console.log('onIndexSetup :: sortableFieldsAttributesTask created', sortableFieldsAttributesTask);

  await client.waitForTasks([
    updateSearchableAttributesTask.taskUid,
    sortableFieldsAttributesTask.taskUid,
  ]);

  console.log('onIndexSetup :: all tasks completed');
};

const onIndexUpdate = async ({ db, lastUpdatedAt }: SearchIndexRunContext) => {
  if (!client) return;

  // Confirm index setup & working:
  await onIndexSetup();

  let offset = 0;
  const tagTasks: EnqueuedTask[] = [];

  // TODO: confirm if the queue can grow big enough that querying without a limit can be a concern.
  const queuedItems = await db.searchIndexUpdateQueue.findMany({
    select: {
      id: true,
    },
    where: {
      type: INDEX_NAME,
    },
  });

  // TODO: Remove limit condition here. We should fetch until break
  while (offset < READ_BATCH_SIZE) {
    console.log(`onIndexUpdate :: fetching ${INDEX_NAME}`, offset, READ_BATCH_SIZE);
    const tags = await db.tag.findMany({
      skip: offset,
      take: READ_BATCH_SIZE,
      select: {
        id: true,
        name: true,
        nsfw: true,
        isCategory: true,
        metrics: {
          select: {
            postCount: true,
            articleCount: true,
            followerCount: true,
            modelCount: true,
            imageCount: true,
            hiddenCount: true,
          },
          where: {
            timeframe: MetricTimeframe.AllTime,
          },
        },
      },
      where: {
        unlisted: false,
        adminOnly: false,
        // if lastUpdatedAt is not provided,
        // this should generate the entirety of the index.
        OR: !lastUpdatedAt
          ? undefined
          : [
              {
                createdAt: {
                  gt: lastUpdatedAt,
                },
              },
              {
                updatedAt: {
                  gt: lastUpdatedAt,
                },
              },
              {
                id: {
                  in: queuedItems.map(({ id }) => id),
                },
              },
            ],
      },
    });

    console.log(`onIndexUpdate :: ${INDEX_NAME} fetched`, tags);

    // Avoids hitting the DB without data.
    if (tags.length === 0) break;

    console.log(`onIndexUpdate :: ${INDEX_NAME} prepared for indexing`, tags);
    const indexReadyRecords = tags.map((tagRecord) => {
      return {
        ...tagRecord,
        metrics: {
          // Flattens metric array
          ...(tagRecord.metrics[0] || {}),
        },
      };
    });

    tagTasks.push(await client.index(`${INDEX_NAME}`).updateDocuments(indexReadyRecords));

    console.log('onIndexUpdate :: task pushed to queue');

    offset += tags.length;
  }

  console.log('onIndexUpdate :: start waitForTasks');
  await client.waitForTasks(tagTasks.map((task) => task.taskUid));
  console.log('onIndexUpdate :: complete waitForTasks');
};

export const tagsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_NAME,
  onIndexUpdate,
});
