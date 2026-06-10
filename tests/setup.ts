// 测试环境：内存库 + mock LLM（在任何业务模块导入前生效）
process.env.DATABASE_PATH = ":memory:";
process.env.LLM = "mock";
process.env.SESSION_SECRET = "test-secret";
