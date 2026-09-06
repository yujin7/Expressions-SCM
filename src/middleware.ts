import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { withinSessionLifetime } from "@/server/auth/session-policy";
import { loginOriginForRequest } from "@/server/auth/login-origin";

/**
 * 只读验证 JWE；正式 auth() / 登录接口负责 8 小时续期和实时权限校验。
 * 不使用 NextAuth 的 auth 包装器：它会重新签发 Cookie，空 provider 配置还会
 * 落入默认 30 天续期，并把静态 Secure 属性写回本机 HTTP / 公网 HTTPS 两个入口。
 * getToken 复用 Auth.js 的分片读取与解密，不引入 pg/argon2 等 Node 原生依赖。
 */
const SESSION_COOKIE_NAME = "authjs.session-token";

/** 公开路径根：仅根本身或其子路径公开，名称相近的兄弟路径仍须认证。 */
const PUBLIC_PATHS = ["/supplier/confirm", "/e-label", "/api/public"];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((root) => path === root || path.startsWith(`${root}/`));
}

export default async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // Exact confirmation page only: expired/damaged cookies must not prevent their
  // owner from clearing this browser's session. The Auth.js POST retains CSRF.
  if (path === "/signout") return NextResponse.next();
  if (isPublicPath(path)) return NextResponse.next(); // 公开：token 在业务层校验

  const secret = process.env.AUTH_SECRET;
  const token = secret ? await getToken({
    // getToken 还支持 Bearer，原有会话入口只接受 Cookie，不扩大认证范围。
    req: { headers: new Headers({ cookie: req.headers.get("cookie") ?? "" }) },
    secret,
    cookieName: SESSION_COOKIE_NAME,
    salt: SESSION_COOKIE_NAME,
  }) : null;

  // 这里只做粗粒度令牌校验。RSC/API 的 auth() 与写路径的 getFreshSessionUser
  // 仍负责 active/sessionVersion/角色及 D62 数据范围，不能用此 token 直接做业务授权。
  if (!withinSessionLifetime(token)) {
    // API 客户端要机器可读错误，不要 302 HTML（RT4）；页面仍走登录跳转
    if (path.startsWith("/api/")) {
      return Response.json({ error: "未登录" }, { status: 401 });
    }
    const origin = loginOriginForRequest(req, process.env.AUTH_URL);
    if (!origin) {
      // Static, same-origin escape hatch for alternate LAN entry points. Never
      // reflect the supplied Host/URL or turn an unknown host into a redirect.
      return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>请登录</title><body><p>此入口未配置自动登录跳转，可在当前入口登录，或使用管理员提供的系统地址。</p><p><a href="/login">在当前入口登录</a></p></body></html>', {
        status: 400,
        headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "private, no-store" },
      });
    }
    const loginUrl = new URL("/login", origin);
    loginUrl.searchParams.set("callbackUrl", path + req.nextUrl.search);
    // Next.js adapter 会用 NextURL 再解析 Location，因此必须是绝对 URL。
    // next.config 的 skipMiddlewareUrlNormalize 防止它把 loopback 再改成 localhost。
    return NextResponse.redirect(loginUrl, 302);
  }
  return NextResponse.next();
}

export const config = {
  // 除 /login、/api/auth/*、/_next/*、favicon、公开 token 门户外全部需要登录
  /* 品牌静态资源必须放行：logo.png / icon.png 出现在**登录页**与浏览器标签页上，
     而登录页正是未登录状态。被中间件拦下会 302 到登录页本身，
     结果是"登录页上的 logo 裂图"——本机实跑时实测就是这样发现的。 */
  matcher: [
    "/((?!login(?:/|$)|api/auth(?:/|$)|api/health(?:/|$)|supplier/confirm(?:/|$)|e-label(?:/|$)|api/public(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$|logo\\.png$|icon\\.png$).*)",
  ],
};
