import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import prisma from "./db";
import {
	polar,
	checkout,
	portal,
	usage,
	webhooks,
} from "@polar-sh/better-auth";
import { polarClient } from "@/modules/payment/config/polar";

import {
	SubscriptionTier,
	updatePolarCustomerId,
	updateUserTier,
} from "@/modules/payment/lib/subscription";

if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
	throw new Error("Missing required GitHub OAuth environment variables");
}

export const auth = betterAuth({
	database: prismaAdapter(prisma, {
		provider: "postgresql",
	}),

	socialProviders: {
		github: {
			clientId: process.env.GITHUB_CLIENT_ID,
			clientSecret: process.env.GITHUB_CLIENT_SECRET,
			scope: ["repo"], // optional
		},
	},

		plugins: [
		polar({
			client: polarClient,
			createCustomerOnSignUp: true,
			use: [
				checkout({
					products: [
						{
							productId: "9e306d45-3b7b-47e4-925c-b223238711b9",
							slug: "codefox-sigmadev" // Custom slug for easy reference in Checkout URL, e.g. /checkout/codefox-sigmadev
						},
					],
					successUrl:
						process.env.POLAR_SUCCESS_URL ||
						"/dashboard/subscriptions?success=true",
					authenticatedUsersOnly: true,
				}),
				portal({
					returnUrl:
						process.env.NEXT_PUBLIC_APP_URL ||
						"http://localhost:3000/dashboard",
				}),
				usage(),
				webhooks({
					secret: process.env.POLAR_WEBHOOK_SECRET!,

					onSubscriptionActive: async (payload) => {
						const customerId = payload.data.customerId;

						const user = await prisma.user.findUnique({
							where: {
								polarCustomerId: customerId,
							},
						});

						if (user) {
							await updateUserTier(
								user.id,
								"PRO",
								"ACTIVE",
								payload.data.id
							);
						}
					},
					/**
					 * Handles the 'subscription.canceled' event from Polar.
					 * Updates the user's status to CANCELLED.
					 * Note: The tier might remain valid until the end of the billing period,
					 * but here we just mark the status.
					 */
					onSubscriptionCanceled: async (payload) => {
						const customerId = payload.data.customerId;

						const user = await prisma.user.findUnique({
							where: {
								polarCustomerId: customerId,
							},
						});

						if (user) {
							await updateUserTier(
								user.id,
								user.subscriptionStatus as SubscriptionTier,
								"CANCELLED"
							);
						}
					},
					/**
					 * Handles the 'subscription.revoked' event from Polar.
					 * Downgrades the user to FREE and updates status to EXPIRED.
					 */
					onSubscriptionRevoked: async (payload) => {
						const customerId = payload.data.customerId;

						const user = await prisma.user.findUnique({
							where: {
								polarCustomerId: customerId,
							},
						});

						if (user) {
							await updateUserTier(user.id, "FREE", "EXPIRED");
						}
					},
					onOrderPaid: async () => {},
					/**
					 * Handles the 'customer.created' event.
					 * Links the local user record with the Polar customer ID.
					 */
					onCustomerCreated: async (payload) => {
						// extra check lagaya hai 
						if (typeof payload.data.email !== "string") {
							return;
						}

						const user = await prisma.user.findUnique({
							where: {
								email: payload.data.email,
							},
						});

						if (user) {
							await updatePolarCustomerId(
								user.id,
								payload.data.id
							);
						}
					},
				}),
				
				],
        })
    ]
});