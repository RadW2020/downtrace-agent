const express = require("express");

function createApp(pool) {
  const app = express();

  app.get("/posts", async (_req, res) => {
    const { rows: posts } = await pool.query("select id, title, author_id from posts order by id");
    res.json(posts);
  });

  return app;
}

module.exports = { createApp };
