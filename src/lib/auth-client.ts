import { createAuthClient } from "better-auth/react";
import { polarClient } from "@polar-sh/better-auth";

const baseURL = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;

if (!baseURL) {
	throw new Error("BETTER_AUTH_URL environment variable is not defined");
}

export const { signIn, signUp, useSession, signOut } = createAuthClient({
	baseURL,
	plugins: [polarClient()],
}); 