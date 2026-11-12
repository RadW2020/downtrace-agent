const request = require("supertest");
const { createApp } = require("../src/app");
const { createPool } = require("../src/db");

const pool = createPool();
const app = createApp(pool);

beforeAll(async () => {
  await pool.query("drop table if exists posts, authors");
  await pool.query("create table authors (id int primary key, name text not null)");
  await pool.query("create table posts (id int primary key, title text not null, author_id int references authors)");
  await pool.query("insert into authors values (1, 'Ada'), (2, 'Grace')");
  await pool.query("insert into posts select n, 'Post ' || n, 1 + n % 2 from generate_series(1, 5) n");
});

afterAll(() => pool.end());

test("GET /posts lists every post", async () => {
  const res = await request(app).get("/posts").expect(200);
  expect(res.body.map((post) => post.title)).toEqual(["Post 1", "Post 2", "Post 3", "Post 4", "Post 5"]);
});
