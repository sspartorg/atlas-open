import type { Knex } from 'knex';

// `comments.agent_id` is ON DELETE SET NULL, so deleting an agent erased its
// name from every comment it wrote. The name is copied onto the comment when
// it is written (`commentsService.create`) and backfilled here for comments
// whose agent still exists.

export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable('comments', (t) => {
        t.text('author_name').nullable();
    });
    await knex.raw('UPDATE comments c SET author_name = a.name FROM agents a WHERE a.id = c.agent_id');
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable('comments', (t) => {
        t.dropColumn('author_name');
    });
}
