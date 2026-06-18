import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TwentyClient } from '../client/twenty-client.js';

export function registerActivityTools(server: McpServer, client: TwentyClient) {
  server.tool(
    'get_activities',
    'Get unified activities timeline from Twenty CRM (tasks, notes, etc.)',
    {
      type: z.array(z.enum(['task', 'note'])).optional().describe('Filter by activity types'),
      dateFrom: z.string().optional().describe('Start date filter (ISO 8601 format)'),
      dateTo: z.string().optional().describe('End date filter (ISO 8601 format)'),
      authorId: z.string().optional().describe('Filter by author/assignee ID'),
      limit: z.coerce.number().optional().default(20).describe('Maximum number of activities to return'),
      offset: z.coerce.number().optional().default(0).describe('Number of activities to skip'),
    },
    async (args) => {
      try {
        const timeline = await client.getActivities({
          type: args.type,
          dateFrom: args.dateFrom,
          dateTo: args.dateTo,
          authorId: args.authorId,
          limit: args.limit,
          offset: args.offset,
        });

        const activitiesText = timeline.activities.map(activity => {
          const authorName = activity.author 
            ? `${activity.author.name.firstName} ${activity.author.name.lastName}`
            : 'Unknown';
          
          const createdDate = new Date(activity.createdAt).toLocaleDateString();
          
          return `[${activity.type.toUpperCase()}] ${activity.title || 'Untitled'} (${createdDate})
Author: ${authorName}
${activity.body ? `Content: ${activity.body.substring(0, 200)}${activity.body.length > 200 ? '...' : ''}` : ''}
ID: ${activity.id}
---`;
        }).join('\n\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Activities Timeline (${timeline.totalCount} total, showing ${timeline.activities.length}):

${activitiesText}

${timeline.hasMore ? 'Use offset parameter to load more activities.' : 'No more activities to load.'}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error retrieving activities: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }
  );

  server.tool(
    'filter_activities',
    'Filter activities by specific criteria',
    {
      type: z.array(z.enum(['task', 'note'])).optional().describe('Activity types to include'),
      dateFrom: z.string().optional().describe('Start date (ISO 8601 format)'),
      dateTo: z.string().optional().describe('End date (ISO 8601 format)'),
      authorId: z.string().optional().describe('Filter by author/assignee ID'),
      status: z.array(z.string()).optional().describe('Task status filter (for tasks only)'),
      limit: z.coerce.number().optional().default(20).describe('Maximum number of results'),
      offset: z.coerce.number().optional().default(0).describe('Number of results to skip'),
    },
    async (args) => {
      try {
        const activities = await client.filterActivities({
          type: args.type,
          dateFrom: args.dateFrom,
          dateTo: args.dateTo,
          authorId: args.authorId,
          status: args.status,
          limit: args.limit,
          offset: args.offset,
        });

        if (activities.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No activities found matching the specified criteria.'
            }]
          };
        }

        const resultsText = activities.map((activity, index) => {
          const authorName = activity.author 
            ? `${activity.author.name.firstName} ${activity.author.name.lastName}`
            : 'Unknown';
          
          return `${index + 1}. [${activity.type.toUpperCase()}] ${activity.title || 'Untitled'}
   Created: ${new Date(activity.createdAt).toLocaleString()}
   Author: ${authorName}
   ID: ${activity.id}`;
        }).join('\n\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Found ${activities.length} activities matching criteria:

${resultsText}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error filtering activities: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }
  );

  server.tool(
    'get_entity_activities',
    'Get all activities related to a specific entity (person, company, or opportunity)',
    {
      entityId: z.string().describe('ID of the entity'),
      entityType: z.enum(['person', 'company', 'opportunity']).describe('Type of entity'),
      includeComments: z.boolean().optional().default(true).describe('Include comments in results'),
      limit: z.coerce.number().optional().default(20).describe('Maximum number of activities'),
      offset: z.coerce.number().optional().default(0).describe('Number of activities to skip'),
    },
    async (args) => {
      try {
        const timeline = await client.getEntityActivities({
          entityId: args.entityId,
          entityType: args.entityType,
          includeComments: args.includeComments,
          limit: args.limit,
          offset: args.offset,
        });

        if (timeline.activities.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `No activities found for ${args.entityType} ${args.entityId}.`
            }]
          };
        }

        const activitiesText = timeline.activities.map((activity, index) => {
          const authorName = activity.author 
            ? `${activity.author.name.firstName} ${activity.author.name.lastName}`
            : 'Unknown';
          
          const date = new Date(activity.createdAt);
          
          return `${index + 1}. [${activity.type.toUpperCase()}] ${activity.title || 'Untitled'}
   Created: ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}
   Author: ${authorName}
   ${activity.body ? `Preview: ${activity.body.substring(0, 150)}${activity.body.length > 150 ? '...' : ''}` : ''}`;
        }).join('\n\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Activities for ${args.entityType} ${args.entityId} (${timeline.totalCount} total):

${activitiesText}

${timeline.hasMore ? `Use offset=${args.offset! + args.limit!} to load more activities.` : 'No more activities available.'}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error retrieving entity activities: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }
  );
}

// Note read tools and a UI deep-link helper. The upstream/base fork only
// exposes create_note; these add read access (search / get / list) plus
// get_record_url so agents can hand users a clickable Twenty UI link.
export function registerNoteTools(server: McpServer, client: TwentyClient) {
  const formatNote = (note: any): string => {
    const created = note.createdAt ? new Date(note.createdAt).toLocaleDateString() : 'unknown date';
    const body = note.bodyV2?.markdown ?? '';
    const preview = body ? `\n   ${body.substring(0, 200)}${body.length > 200 ? '...' : ''}` : '';
    return `[NOTE] ${note.title || 'Untitled'} (${created})\n   ID: ${note.id}${preview}`;
  };

  server.tool(
    'search_notes',
    'Search notes in Twenty CRM by title (case-insensitive partial match)',
    {
      searchTerm: z.string().describe('Text to match against note titles'),
      limit: z.coerce.number().optional().default(20).describe('Maximum number of notes to return'),
    },
    async (args) => {
      try {
        const notes = await client.searchNotes(args.searchTerm, { limit: args.limit });
        if (notes.length === 0) {
          return { content: [{ type: 'text' as const, text: `No notes found matching "${args.searchTerm}".` }] };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `Found ${notes.length} note(s) matching "${args.searchTerm}":\n\n${notes.map(formatNote).join('\n\n')}`
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error searching notes: ${error instanceof Error ? error.message : 'Unknown error'}` }] };
      }
    }
  );

  server.tool(
    'get_note',
    'Get a single note by ID from Twenty CRM',
    {
      id: z.string().describe('Note ID'),
    },
    async (args) => {
      try {
        const note = await client.getNote(args.id);
        if (!note) {
          return { content: [{ type: 'text' as const, text: `No note found with ID ${args.id}.` }] };
        }
        const body = note.bodyV2?.markdown ?? '(no body)';
        return {
          content: [{
            type: 'text' as const,
            text: `[NOTE] ${note.title || 'Untitled'}\nID: ${note.id}\nCreated: ${note.createdAt ?? 'unknown'}\n\n${body}`
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error retrieving note: ${error instanceof Error ? error.message : 'Unknown error'}` }] };
      }
    }
  );

  server.tool(
    'list_notes',
    'List notes in Twenty CRM, newest first',
    {
      limit: z.coerce.number().optional().default(20).describe('Maximum number of notes to return'),
      offset: z.coerce.number().optional().default(0).describe('Number of notes to skip'),
    },
    async (args) => {
      try {
        const notes = await client.listNotes({ limit: args.limit, offset: args.offset });
        if (notes.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No notes found.' }] };
        }
        return {
          content: [{
            type: 'text' as const,
            text: `Notes (showing ${notes.length}):\n\n${notes.map(formatNote).join('\n\n')}`
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error listing notes: ${error instanceof Error ? error.message : 'Unknown error'}` }] };
      }
    }
  );

  server.tool(
    'get_record_url',
    'Build a Twenty UI deep-link for a record so it can be opened in a browser',
    {
      objectName: z.string().describe('Object API name, e.g. company, person, opportunity, note, task'),
      recordId: z.string().describe('The record ID'),
    },
    async (args) => {
      try {
        const url = client.getRecordUrl(args.objectName, args.recordId);
        return { content: [{ type: 'text' as const, text: url }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Error building record URL: ${error instanceof Error ? error.message : 'Unknown error'}` }] };
      }
    }
  );
}