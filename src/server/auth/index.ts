import NextAuth from "next-auth";
import { authConfigForRequest } from "./config";

export const { handlers, auth, signIn, signOut } = NextAuth((request) => authConfigForRequest(request));
export { feishuEnabled } from "./config";
