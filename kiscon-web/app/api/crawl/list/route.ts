import { NextRequest, NextResponse } from 'next/server';
import { crawlListPage } from '@/lib/crawler';

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { startDate, endDate, page = 1 } = body;

        if (!startDate || !endDate) {
            return NextResponse.json(
                { error: 'startDate and endDate are required' },
                { status: 400 }
            );
        }

        const fromDate = new Date(startDate);
        const toDate = new Date(endDate);

        if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
            return NextResponse.json(
                { error: 'Invalid date format' },
                { status: 400 }
            );
        }

        const result = await crawlListPage(fromDate, toDate, page);

        return NextResponse.json(result);
    } catch (error) {
        console.error('Crawl list error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorStack = error instanceof Error ? error.stack : undefined;
        return NextResponse.json(
            { error: errorMessage, details: errorStack, success: false },
            { status: 500 }
        );
    }
}
