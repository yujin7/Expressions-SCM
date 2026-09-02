import NextAuth from "next-auth";
import { authCookieConfig } from "@/server/auth/cookies";

/**
 * 中间件里单独实例化一个"空 provider"的 NextAuth：
 * 只做 JWT 会话校验（同一 AUTH_SECRET 可解签），
 * 避免把 pg/@node-rs/argon2 等 Node 原生依赖拖进 Edge runtime。
 */
const { auth } = NextAuth({
  providers: [],
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  // 8 小时 JWT 会话；所有业务写操作通过 getFreshSessionUser 回查 active/session_version/角色，变更即时生效。
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  // 中间件只读取会话，不签发 Cookie；固定名称必须与请求感知的认证路由一致。
  ...authCookieConfig(),
});

/** 公开路径根：仅根本身或其子路径公开，名称相近的兄弟路径仍须认证。 */
const PUBLIC_PATHS = ["/supplier/confirm", "/e-label", "/api/public"];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((root) => path === root || path.startsWith(`${root}/`));
}

export default auth((req) => {
  const path = req.nextUrl.pathname;
  if (isPublicPath(path)) return; // 公开：token 在业务层校验
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
  // 除 /login、/api/auth/*、/_next/*、favicon、公开 token 门户外全部需要登录
  /* 品牌静态资源必须放行：logo.png / icon.png 出现在**登录页**与浏览器标签页上，
     而登录页正是未登录状态。被中间件拦下会 302 到登录页本身，
     结果是"登录页上的 logo 裂图"——本机实跑时实测就是这样发现的。 */
  matcher: [
    "/((?!login(?:/|$)|api/auth(?:/|$)|api/health(?:/|$)|supplier/confirm(?:/|$)|e-label(?:/|$)|api/public(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$|logo\\.png$|icon\\.png$).*)",
  ],
};
