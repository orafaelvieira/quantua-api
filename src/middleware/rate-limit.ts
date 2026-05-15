import rateLimit from "express-rate-limit";

const baseConfig = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas requisições. Tente novamente em alguns minutos." },
};

/** 10 requisições por IP por hora — públicos sensíveis (lead capture, accept-invite). */
export const publicWriteLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 60 * 1000,
  max: 10,
});

/** 60 GETs por IP por hora — preview de magic link (browser pode polled). */
export const publicReadLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 60 * 1000,
  max: 60,
});

/** 20 tentativas por IP por 15min — login (proteção brute force). */
export const loginLimiter = rateLimit({
  ...baseConfig,
  windowMs: 15 * 60 * 1000,
  max: 20,
});

/** 5 invites por engagement por hora — anti-spam de convite. */
export const inviteLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `invite:${req.params.id ?? "global"}`,
});

/** 3 reenvios de magic link por email por hora. */
export const resendLimiter = rateLimit({
  ...baseConfig,
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `resend:${(req.body?.email ?? req.ip ?? "anon").toLowerCase()}`,
});
