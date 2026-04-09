import { pineconeIndex } from "@/lib/pinecone";
import { embed, embedMany } from "ai";
import { google } from "@ai-sdk/google";

// Constants for fine-tuning
const MAX_TOKEN_CHARS = 8000; // Gemini-embedding-001 limit is ~8k tokens
const PINECONE_BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const EMBEDDING_DELAY_MS = 200; // 200ms delay between embedding calls to stay within 30k TPM

// Rate limiting: ensure we stay within 30k TPM
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 1. ENHANCED EMBEDDING GENERATOR
 * Handles cleaning, validation, silent failure, and rate limiting for 30k TPM.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!text || typeof text !== "string" || text.trim().length === 0) return null;

  const sanitizedText = text.replace(/\s+/g, " ").trim();
  
  // Console message before slicing at token limit
  if (sanitizedText.length > MAX_TOKEN_CHARS) {
    console.warn(`⚠️ TEXT TRUNCATION: Document length ${sanitizedText.length} chars exceeds limit ${MAX_TOKEN_CHARS}. Slicing to fit within token limit...`);
  }
  
  const truncatedText = sanitizedText.slice(0, 8000);

  try {
    // Add delay to stay within 30k TPM limit
    await sleep(EMBEDDING_DELAY_MS);

    const result = await embed({
      model: google.embedding("gemini-embedding-001"),
      value: truncatedText,
    });

    // Check if result exists before touching properties
    if (result && 'embedding' in result) {
      return result.embedding;
    }
    
    return null;
  } catch (error: any) {
    // This will now catch 401 (Invalid Key) or 429 (Rate Limit)
    console.error(`❌ Embedding API Error: ${error.message}`);
    return null; 
  }
}

/**
 * 2. COMPREHENSIVE CODEBASE INDEXER
 * Uses Batching and robust error boundaries.
 * Processes sequentially with delays to stay within 30k TPM.
 */
export async function indexCodebase(
  repoId: string,
  files: { path: string; content: string }[]
) {
  console.log(`🚀 Starting index for Repo: ${repoId} (${files.length} files)`);
  
  const vectors: any[] = [];

  // Process files sequentially with delay to avoid hitting rate limit
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      // Create a context-rich string for the LLM
      const documentBody = `File Path: ${file.path}\nContent: ${file.content}`;
      
      const embedding = await generateEmbedding(documentBody); // Already has EMBEDDING_DELAY_MS built-in

      if (embedding) {
        vectors.push({
          // Create a deterministic, URL-safe ID
          id: Buffer.from(`${repoId}:${file.path}`).toString('base64'),
          values: embedding,
          metadata: {
            repoId,
            filePath: file.path,
            // Store a snippet for context, not the whole file if it's huge
            content: file.content.slice(0, 3000), 
            updatedAt: new Date().toISOString(),
          },
        });
      }

      // Log progress every 10 files
      if ((i + 1) % 10 === 0) {
        console.log(`📊 Processed ${i + 1}/${files.length} files...`);
      }
    } catch (error) {
      console.error(`❌ Critical failure on file ${file.path}:`, error);
      // Continue to next file instead of crashing the whole job
      continue; 
    }
  }

  // 3. ROBUST PINECONE UPSERT (With Batching)
  if (vectors.length === 0) {
    return { success: false, message: "No valid embeddings were generated." };
  }

  try {
    for (let i = 0; i < vectors.length; i += PINECONE_BATCH_SIZE) {
      const batch = vectors.slice(i, i + PINECONE_BATCH_SIZE);
      console.log(`Symbols: 📦 Upserting batch ${i / PINECONE_BATCH_SIZE + 1}...`);
      
      // Pinecone SDK v6+ syntax
      await pineconeIndex.upsert(batch);
    }

    console.log("✅ Indexing complete.");
    return { success: true, count: vectors.length };
  } catch (error) {
    console.error("❌ Pinecone Batch Upsert Failed:", error);
    throw error; // Re-throw so Inngest knows to retry the storage phase
  }
}

/**
 * 4. FAIL-SAFE CONTEXT RETRIEVAL
 */
export async function retrieveContext(
  query: string,
  repoId: string,
  topK: number = 7
) {
  try {
    const queryEmbedding = await generateEmbedding(query);

    if (!queryEmbedding) {
      console.warn("⚠️ Query embedding failed. Returning empty context.");
      return [];
    }

    const queryResponse = await pineconeIndex.query({
      vector: queryEmbedding,
      // Use standard metadata filtering
      filter: { repoId: { $eq: repoId } },
      topK,
      includeMetadata: true,
    });

    // Extract and filter out any empty matches safely
    const context = (queryResponse.matches || [])
      .map((match) => match.metadata?.content as string)
      .filter((content) => !!content && content.length > 0);

    return context;
  } catch (error) {
    console.error("❌ Context retrieval failed:", error);
    return [];
  }
}

// import { pineconeIndex } from "@/lib/pinecone";

// import { embed } from "ai";
// import { google } from "@ai-sdk/google";





// export async function generateEmbedding(text: string) {
//   // 1. Guard against undefined or empty content
//   if (!text || typeof text !== 'string' || text.trim().length === 0) {
//     console.warn("⚠️ Skipping embedding: Content is empty or undefined");
//     return null; 
//   }

//   try {
//     console.log("🧠 Generating embedding...");

//     const result = await embed({
//       model: google.textEmbedding("gemini-embedding-001"),
//       value: text.replace(/\n/g, ' '), // Clean up newlines for better vector quality
//     });

//     // 2. Safely extract the embedding
//     // Vercel AI SDK usually puts it in 'embedding'. 
//     // We use optional chaining and a fallback to null.
//     const embedding = result?.embedding;

//     // 3. Safety check before accessing .length
//     if (!embedding || !Array.isArray(embedding)) {
//       console.error("❌ Provider did not return a valid embedding array");
//       return null;
//     }

//     console.log("✅ Embedding generated, length:", embedding.length);
//     return embedding;

//   } catch (error) {
//     console.error("❌ Critical Error during embedding:", error);
//     // Return null instead of throwing so the rest of your files can still be indexed
//     return null; 
//   }
// }
// // export async function generateEmbedding(text: string) {
// // 	const { embedding } = await embed({
// // 		model: google.textEmbedding("gemini-embedding-001"),
// // 		value: text,
// // 		providerOptions: {
// // 			google: {
// // 				outputDimensionality: 3072,
// // 				taskType: "SEMANTIC_SIMILARITY",
// // 			},
// // 		},
// // 	});

// // 	return embedding;
// // }

// export async function indexCodebase(
// 	repoId: string,
// 	files: { path: string; content: string }[]
// ) {
// 	const vectors = [];

// 	for (const file of files) {
// 		const content = `File: ${file.path}\n\n${file.content}`;
// 		const truncatedContent = content.slice(0, 8000);

// 		try {
// 			const embedding = await generateEmbedding(truncatedContent);
// 			vectors.push({
// 				id: `${repoId}-${file.path.replace(/\//g, "_")}`,
// 				values: embedding,
// 				metadata: {
// 					repoId,
// 					filePath: file.path,
// 					content: truncatedContent,
// 				},
// 			});
// 		} catch (error) {
// 			console.error(`Failed to embed ${file.path}:`, error);
// 		}
// 	}

// 	if (vectors.length > 0) {
// 		const batchSize = 100;

// 		for (let i = 0; i < vectors.length; i += batchSize) {
// 			const batch = vectors.slice(i, i + batchSize);
// 			console.log(`Upserting batch with ${batch.length} vectors to Pinecone...`);
// 			await pineconeIndex.upsert({ records: batch });	
// 			console.log("Upserting to Pinecone...");
// 		}
// 	}

// 	console.log("Indexing completed");
// 	return {
// 		success: true,
// 		vectorsStored: vectors.length,
// 	};
// }

// export async function retrieveContext(
// 	query: string,
// 	repoId: string,
// 	topK: number = 5
// ) {
// 	const embedding = await generateEmbedding(query);

// 	const results = await pineconeIndex.query({
// 		vector: embedding,
// 		filter: { repoId },
// 		topK,
// 		includeMetadata: true,
// 	});

// 	return results.matches
// 		.map((match) => match.metadata?.content as string)
// 		.filter(Boolean);
// }