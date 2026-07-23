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

export default auth((req) => {
  if (!req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return Response.redirect(loginUrl);
  }
});

export const config = {
  // 除 /login、/api/auth/*、/_next/*、favicon 外全部需要登录
  matcher: ["/((?!login|api/auth|api/health|_next/static|_next/image|favicon.ico).*)"],
};
