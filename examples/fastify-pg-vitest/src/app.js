import Fastify from "fastify";

export function createApp(pool) {
  const app = Fastify();

  app.get("/posts", async () => {
    const { rows: posts } = await pool.query("select id, title, author_id from posts order by id");
    return posts;
  });

  return app;
}
