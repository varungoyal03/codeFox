import { NextRequest, NextResponse } from 'next/server';
import { retrieveContext } from '@/modules/ai/lib/rag';
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';

export async function POST(req: NextRequest) {
  try {
    const { question, repoId = 'codefox' } = await req.json();

    if (!question) {
      return NextResponse.json({ error: 'Missing question' }, { status: 400 });
    }

    // 1. Retrieve context using your actual RAG function
    const contextChunks = await retrieveContext(question, repoId, 5);

    // 2. Generate answer using your Gemini setup
    const prompt = `Answer the question based ONLY on the following context.\nIf the context doesn't contain the answer, say "I cannot answer based on the provided context."\n\nContext:\n${contextChunks.join('\n\n')}\n\nQuestion: ${question}\n\nAnswer:`;

    const { text: answer } = await generateText({
      model: google('gemini-2.0-flash-lite-preview'),
      prompt,
    });

    return NextResponse.json({
      success: true,
      answer,
      context: contextChunks,
      contextCount: contextChunks.length,
    });
  } catch (error: any) {
    console.error('Evaluation error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}