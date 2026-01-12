import { NextRequest, NextResponse } from 'next/server';
import { fetchDetailPage } from '@/lib/crawler';

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { seqno, url } = body;

        if (!seqno || !url) {
            return NextResponse.json(
                { error: 'seqno and url are required' },
                { status: 400 }
            );
        }

        const result = await fetchDetailPage(seqno, url);

        return NextResponse.json(result);
    } catch (error) {
        console.error('Crawl detail error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 }
        );
    }
}
