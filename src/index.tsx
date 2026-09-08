import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import type { RequestIdVariables } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { Context, Next } from "hono";
import pino from "pino";
import { Dashboard, type DashboardRow } from "./dashboard";
import { abrirBanco } from "./db";
import { gravarProgresso } from "./progresso";
import { rateLimiter } from "./limite";
import { criarRotasPapel } from "./papel/rotas";
import { criarLocalizadorIA } from "./papel/ia";
import * as dados from "./papel/dados";

// =============================================================================
// Types
// =============================================================================

interface User {
  id: number;
  username: string;
  password: string;
  created_at: Date;
}

interface DocumentMetadata {
  filename?: string;
  title?: string;
  authors?: string;
}

interface Progress {
  id: number;
  user_id: number;
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id: string;
  filename: string | null;
  title: string | null;
  authors: string | null;
  timestamp: number;
}

interface RegisterRequest {
  username: string;
  password: string;
}

interface ProgressUpdateRequest {
  document: string;
  progress: string;
  percentage: number;
  device: string;
  device_id: string;
  metadata?: DocumentMetadata;
}

// =============================================================================
// Config
// =============================================================================

interface Config {
  password: {
    salt: string;
  };
  auth: {
    disableUserRegistration: boolean;
  };
  server: {
    port: number;
    host: string;
  };
}

/** Salt de fábrica: com ele os cookies de sessão do celular seriam forjáveis por qualquer um. */
const SALT_PADRAO = "default_salt_change_in_production";

const config: Config = {
  password: {
    salt: process.env.PASSWORD_SALT || SALT_PADRAO,
  },
  auth: {
    disableUserRegistration:
      process.env.DISABLE_USER_REGISTRATION?.toLowerCase() === "true",
  },
  server: {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || "0.0.0.0",
  },
};

// =============================================================================
// Logger
// =============================================================================

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  serializers: {
    req: (req: any) => ({
      method: req.method,
      url: req.url,
      headers: req.headers
        ? {
            "user-agent": req.headers["user-agent"],
            "content-type": req.headers["content-type"],
            authorization: req.headers["authorization"]
              ? "[REDACTED]"
              : undefined,
          }
        : undefined,
    }),
    res: (res: any) => ({
      statusCode: res.statusCode,
      headers: res.headers
        ? {
            "content-type": res.headers["content-type"],
          }
        : undefined,
    }),
  },
});

// =============================================================================
// Database
// =============================================================================

const db = abrirBanco();
export { db };

// =============================================================================
// Middleware
// =============================================================================

const loggingMiddleware = async (c: Context, next: Next) => {
  const start = Date.now();
  const { method, url } = c.req;
  const requestId = c.get("requestId");

  logger.info(
    {
      requestId,
      req: {
        method,
        url,
      },
    },
    "Incoming request"
  );

  try {
    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    logger.info(
      {
        requestId,
        res: {
          statusCode: status,
        },
        duration,
      },
      "Request completed"
    );
  } catch (error) {
    const duration = Date.now() - start;
    const requestId = c.get("requestId");

    logger.error(
      {
        requestId,
        err: error,
        duration,
      },
      "Request failed"
    );

    throw error;
  }
};

const errorHandler = (error: Error, c: Context) => {
  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  const requestId = c.get("requestId");

  logger.error(
    {
      requestId,
      err: error,
      req: {
        method: c.req.method,
        url: c.req.url,
      },
    },
    "Unhandled error"
  );

  return c.json({ error: "Internal server error" }, 500);
};

// =============================================================================
// Auth
// =============================================================================

type AuthVariables = {
  userId: number;
};

async function authMiddleware(
  c: Context<{ Variables: AuthVariables }>,
  next: Next
) {
  const username = c.req.header("x-auth-user");
  const password = c.req.header("x-auth-key");
  const requestId = c.get("requestId");

  logger.debug({ requestId, username }, "Authentication attempt");

  if (!username || !password) {
    logger.warn(
      { requestId, username },
      "Authentication failed: missing credentials"
    );
    throw new HTTPException(401, { message: "Authentication required" });
  }

  const user = db
    .prepare("SELECT id, username, password FROM users WHERE username = ?")
    .get(username) as User | null;

  const saltedPassword = password + config.password.salt;
  if (!user || !(await Bun.password.verify(saltedPassword, user.password))) {
    logger.warn(
      { requestId, username },
      "Authentication failed: invalid credentials"
    );
    throw new HTTPException(401, { message: "Invalid credentials" });
  }

  logger.info(
    { requestId, userId: user.id, username },
    "Authentication successful"
  );
  c.set("userId", user.id);
  await next();
}

// =============================================================================
// App
// =============================================================================

type Variables = {
  userId: number;
} & RequestIdVariables;

const app = new Hono<{ Variables: Variables }>();

// Add secure headers middleware
app.use(
  "*",
  secureHeaders({
    xFrameOptions: false,
    xXssProtection: false,
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  })
);

// Add request ID middleware
app.use("*", requestId());

// Add logging middleware
app.use("*", loggingMiddleware);

// Add error handler
app.onError(errorHandler);

// Rate limit auth-related endpoints
const authRateLimit = rateLimiter({ windowMs: 60_000, max: 10 });
app.use("/users/*", authRateLimit);

// Área do livro de papel (celular): login por sessão, livros, configurações.
// O cookie de sessão é assinado com o salt; no salt de fábrica qualquer um forjaria
// um cookie e entraria como qualquer usuário, então a área inteira fica desligada.
if (config.password.salt === SALT_PADRAO) {
  const desligada = (c: Context) =>
    c.text("Área do celular desligada: defina PASSWORD_SALT.", 503);
  app.all("/papel", desligada);
  app.all("/papel/*", desligada);
  logger.error(
    "PASSWORD_SALT não definido: a área do celular (/papel) está desligada porque o cookie de sessão seria forjável."
  );
} else {
  app.route(
    "/",
    criarRotasPapel({
      db,
      salt: config.password.salt,
      dirLivros: "data/books",
      ia: criarLocalizadorIA(),
      logger,
    })
  );
}

// Register endpoint
app.post("/users/create", async (c) => {
  const requestId = c.get("requestId");

  let body: RegisterRequest;
  try {
    body = await c.req.json<RegisterRequest>();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  if (config.auth.disableUserRegistration) {
    logger.warn({ requestId }, "Registration disabled by configuration");
    throw new HTTPException(403, {
      message: "User registration is disabled",
    });
  }

  logger.info(
    { requestId, username: body.username },
    "User registration attempt"
  );

  if (!body.username || !body.password) {
    logger.warn(
      { requestId, username: body.username },
      "Registration failed: missing credentials"
    );
    throw new HTTPException(400, {
      message: "Username and password are required",
    });
  }

  if (body.username.length > 255 || body.password.length > 255) {
    throw new HTTPException(400, {
      message: "Username and password must be 255 characters or fewer",
    });
  }

  try {
    const saltedPassword = body.password + config.password.salt;
    const hashedPassword = await Bun.password.hash(saltedPassword);
    db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(
      body.username,
      hashedPassword
    );

    logger.info(
      { requestId, username: body.username },
      "User registered successfully"
    );
    return c.json({ username: body.username }, 201);
  } catch (error) {
    logger.warn(
      {
        requestId,
        username: body.username,
        error: error instanceof Error ? error.message : String(error),
      },
      "Registration failed: username already exists"
    );
    return c.json({ error: "Username already exists" }, 409);
  }
});

// Auth endpoint
app.get("/users/auth", authMiddleware, (c) => {
  const userId = c.get("userId");
  const requestId = c.get("requestId");
  logger.info({ requestId, userId }, "User authentication successful");
  return c.json({ authorized: "OK" });
});

// Update progress endpoint
app.put("/syncs/progress", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const requestId = c.get("requestId");

  let body: ProgressUpdateRequest;
  try {
    body = await c.req.json<ProgressUpdateRequest>();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const { document, progress, percentage, device, device_id, metadata } = body;

  logger.info(
    {
      requestId,
      userId,
      document,
      percentage,
      device,
      device_id,
      metadata,
    },
    "Progress update received"
  );

  if (
    !document ||
    !progress ||
    percentage === undefined ||
    !device ||
    !device_id
  ) {
    logger.warn(
      { requestId, userId, body },
      "Progress update failed: missing required fields"
    );
    throw new HTTPException(400, { message: "Missing required fields" });
  }

  try {
    gravarProgresso(db, {
      userId: userId as number,
      document,
      progress,
      percentage,
      device,
      deviceId: device_id,
      filename: metadata?.filename ?? null,
      title: metadata?.title ?? null,
      authors: metadata?.authors ?? null,
    });

    logger.info({ requestId, userId, document, percentage, device, device_id, metadata }, "Progress updated successfully");
    return c.json({ status: "success" }, 200);
  } catch (error) {
    logger.error({ requestId, userId, document, error: error instanceof Error ? error.message : String(error) }, "Failed to update progress");
    throw error;
  }
});

// Get progress endpoint
app.get("/syncs/progress/:document", authMiddleware, (c) => {
  const userId = c.get("userId");
  const requestId = c.get("requestId");
  const document = c.req.param("document");

  logger.info({ requestId, userId, document }, "Progress retrieval requested");

  try {
    const progress = db
      .prepare(
        `
      SELECT progress, percentage, device, device_id, timestamp
      FROM progress
      WHERE user_id = ? AND document = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `
      )
      .get(userId as number, document) as Pick<
      Progress,
      "progress" | "percentage" | "device" | "device_id" | "timestamp"
    > | null;

    if (!progress) {
      logger.info({ requestId, userId, document }, "Progress not found");
      return c.json({ status: "not found" }, 404);
    }

    logger.info(
      {
        requestId,
        userId,
        document,
        percentage: progress.percentage,
        device: progress.device,
      },
      "Progress retrieved successfully"
    );

    return c.json({ document, ...progress });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        document,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to retrieve progress"
    );
    throw error;
  }
});

// List all synced documents with metadata for the authenticated user
app.get("/syncs/documents", authMiddleware, (c) => {
  const userId = c.get("userId");
  const requestId = c.get("requestId");

  logger.info({ requestId, userId }, "Documents list requested");

  try {
    const documents = db
      .prepare(
        `
      SELECT document, progress, percentage, device, device_id,
             filename, title, authors, timestamp
      FROM progress
      WHERE user_id = ?
      ORDER BY timestamp DESC
    `
      )
      .all(userId as number);

    logger.info(
      { requestId, userId, count: documents.length },
      "Documents list retrieved"
    );

    return c.json({ documents });
  } catch (error) {
    logger.error(
      {
        requestId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to list documents"
    );
    throw error;
  }
});

app.get("/health", (c) => {
  const requestId = c.get("requestId");
  logger.debug({ requestId }, "Health check requested");
  return c.json({ status: "ok" });
});

app.get("/", async (c) => {
  const rows = db
    .prepare(
      `
      SELECT user_id, document, percentage, device, filename, title, authors, timestamp
      FROM progress
      ORDER BY timestamp DESC
    `
    )
    .all() as (DashboardRow & { user_id: number })[];
  for (const r of rows) {
    const livro = dados.obterLivro(db, r.user_id, r.document);
    if (livro?.paper_pages) {
      try {
        r.paperPage = dados.paginaEstimada(db, r.user_id, livro, await dados.carregarIndice(livro.index_path));
      } catch {
        // Índice do EPUB ausente: não deixa o painel público quebrar por isso.
      }
    }
  }
  const now = Math.floor(Date.now() / 1000);
  c.header("Cache-Control", "no-store");
  return c.html(<Dashboard rows={rows} now={now} />);
});

app.use(
  "/public/*",
  serveStatic({
    root: "./public",
    rewriteRequestPath: (path) => path.replace(/^\/public/, ""),
    mimes: {
      css: "text/css",
      svg: "image/svg+xml",
      jpg: "image/jpeg",
      mp4: "video/mp4",
      woff2: "font/woff2",
    },
  })
);

// Log startup
logger.info("KOReader Sync Server starting up");

export default app;
