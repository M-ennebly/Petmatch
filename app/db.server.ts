import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

// In production: reuse a single client (efficient connection pooling).
// In development: always use the global singleton but reset it when this
// module first loads in a fresh process. Set NODE_ENV=development explicitly
// via shopify app dev to guarantee a fresh client is created
// after every prisma generate + server restart.
if (!global.prismaGlobal) {
  global.prismaGlobal = new PrismaClient();
}

const prisma = global.prismaGlobal;

export default prisma;
