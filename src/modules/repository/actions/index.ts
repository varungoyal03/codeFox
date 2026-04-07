"use server";

import prisma from "@/lib/db";
import { auth } from "@/lib/auth";
import { getRepositories } from "@/modules/auth/github/lib/github";
import { createWebhook } from "@/modules/auth/github/lib/github";
import { headers } from "next/headers";
import { inngest } from "@/inngest/client";
import { canConnectRepository, incrementRepositoryCount, decrementRepositoryCount } from "@/modules/payment/lib/subscription";

export const fetchRepositories = async (
	page: number = 1,
	perPage: number = 10
) => {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		throw new Error("Unauthorized");
	}

	const githubRepos = await getRepositories(page, perPage);

	const dbRepos = await prisma.repository.findMany({
		where: {
			userId: session.user.id,
		},
	});

	const connectedRepoIds = new Set(dbRepos.map((repo) => repo.githubId));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
	return githubRepos.map((repo: any) => ({
		...repo,
		isConnected: connectedRepoIds.has(BigInt(repo.id)),
	}));
};

export const connectRepository = async (owner: string, repo: string, githubId: number) => {

  const session = await auth.api.getSession({
    headers: await headers()
  })

  if (!session) {
    throw new Error("Unauthorized")
  }

  // TODO: CHECK IF USER CAN CONNECT MORE REPO 
   const canConnect = await canConnectRepository(session.user.id);

   if (!canConnect) {
     throw new Error(
       "Repository limit reached. Please upgrade to Pro for unlimited repositories.",
     );
   }

  const webhook = await createWebhook(owner, repo)

  if (webhook) {
    await prisma.repository.upsert({
      where: {
        githubId: BigInt(githubId)
      },
      create: {
        githubId: BigInt(githubId),
        name: repo,
        owner,
        fullName: `${owner}/${repo}`,
        url: `https://github.com/${owner}/${repo}`,
        userId: session.user.id
      },
      update: {
        userId: session.user.id
      }
    })
  

  // TODO: INCREMENT REPOSITORY COUNT FOR USAGE TRACKING
    // increment repository count part done
	await incrementRepositoryCount(session.user.id);

  // TODO: TRIGGER REPOSITORY INDEXING FOR RAG (FIRE AND FORGET)
  	//  Trigger repository indexing for RAG
	try {
		await inngest.send({
			name: "repository.connected",
			data: {
				owner,
				repo,
				userId: session.user.id,
			},
		});
	} catch (error) {
		console.error("Failed to trigger repository indexing:", error);
	}
}

  return webhook
}