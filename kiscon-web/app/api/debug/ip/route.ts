import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();

        // Also try to guess region from Vercel headers if available, though not always present
        const envRegion = process.env.VERCEL_REGION || 'unknown';

        return NextResponse.json({
            ip: data.ip,
            region: envRegion,
            proxy_configured: !!process.env.PROXY_URL,
            // Mask proxy URL for security
            proxy_url: process.env.PROXY_URL ? process.env.PROXY_URL.replace(/:[^:@]*@/, ':***@') : 'none'
        });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch IP', details: String(error) }, { status: 500 });
    }
}

export const dynamic = 'force-dynamic';
