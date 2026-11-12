import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma.service";

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  const prisma = app.get(PrismaService);
  await prisma.post.deleteMany();
  await prisma.author.deleteMany();
  await prisma.author.createMany({
    data: [
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
    ],
  });
  await prisma.post.createMany({
    data: [1, 2, 3, 4, 5].map((n) => ({ id: n, title: `Post ${n}`, authorId: 1 + (n % 2) })),
  });
});

afterAll(() => app.close());

test("GET /posts lists every post", async () => {
  const res = await request(app.getHttpServer()).get("/posts").expect(200);
  expect(res.body.map((post: { title: string }) => post.title)).toEqual([
    "Post 1",
    "Post 2",
    "Post 3",
    "Post 4",
    "Post 5",
  ]);
});
