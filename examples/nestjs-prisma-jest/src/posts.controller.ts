import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

@Controller("posts")
export class PostsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const posts = await this.prisma.post.findMany({ orderBy: { id: "asc" } });
    return posts;
  }
}
