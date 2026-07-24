import NextAuth from "next-auth";

/**
 * 中间件里单独实例化一个"空 provider"的 NextAuth：
 * 只做 JWT 会话校验（同一 AUTH_SECRET 可解签），
 * 避免把 pg/@node-rs/argon2 等 Node 原生依赖拖进 Edge runtime。
 */
const { auth } = NextAuth({
  providers: [],
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  // 规格要求 DB 会话（角色变更即时生效）——MVP W1 用 JWT，W2 换 DB 会话/加角色版本戳。deviation logged
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
});

/** 公开路径前缀（#13 供应商确认门户——token 门控，无需登录） */
const PUBLIC_PREFIXES = ["/supplier/confirm", "/api/public/"];

export default auth((req) => {
  const path = req.nextUrl.pathname;
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return; // 公开：token 在业务层校验
  if (!req.auth) {
    // API 客户端要机器可读错误，不要 302 HTML（RT4）；页面仍走登录跳转
    if (path.startsWith("/api/")) {
      return Response.json({ error: "未登录" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", path + req.nextUrl.search);
    return Response.redirect(loginUrl);
  }
});

export const config = {
  // 除 /login、/api/auth/*、/_next/*、favicon、公开门户外全部需要登录
  matcher: ["/((?!login|api/auth|api/health|supplier/confirm|api/public|_next/static|_next/image|favicon.ico).*)"],
};
