// lib/crawler.ts
import axios from 'axios';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { HttpsProxyAgent } from 'https-proxy-agent';

const BASE_URL = 'https://www.kiscon.net/cis/coad_disposenotice_07.asp';
const VIEW_URL = 'https://www.kiscon.net/cis/coad_disposenotice_view_07.asp';

const NO_RESULT_PATTERNS = [
  '검색 결과가 없습니다',
  '조회 결과가 없습니다',
  '검색결과가 없습니다',
];

const LIST_HEADER_KEYWORDS = [
  'No', '공고번호', '공고일자', '대상업체', '해당업종', '처분내용', '소재지', '종류', '비고'
];

export interface NoticeRow {
  seqno: string;
  notice_url: string;
  [key: string]: string;
}

export interface CrawlListResult {
  data: NoticeRow[];
  totalPages: number;
  currentPage: number;
}

// Build query parameters for KISCON search
export function buildQueryParams(
  fromDate: Date,
  toDate: Date,
  page: number = 1
): Record<string, any> {
  return {
    mode: 1,
    GotoPage: page,
    fromYear: fromDate.getFullYear(),
    toYear: toDate.getFullYear(),
    fromMonth: fromDate.getMonth() + 1,
    toMonth: toDate.getMonth() + 1,
    fromDay: fromDate.getDate(),
    toDay: toDate.getDate(),
    level: '',
    item: '',
    area: '',
    areadetail: '',
    decode: '',
    mattercode: '',
    accept: '',
    kname: '',
    ecode_A: '',
    ecode_B: '',
  };
}

// Fetch HTML with proper encoding handling
export async function fetchHtml(url: string, params?: Record<string, any>): Promise<string> {
  const proxyUrl = process.env.PROXY_URL;
  const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  if (proxyUrl) {
    console.log(`Using proxy: ${proxyUrl.replace(/:[^:@]*@/, ':***@')}`);
  }

  const response = await axios.get(url, {
    params,
    responseType: 'arraybuffer',
    httpsAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': BASE_URL,
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    timeout: 120000,
  }).catch((error) => {
    if (axios.isAxiosError(error)) {
      console.error(`Fetch error for ${url}:`, {
        message: error.message,
        code: error.code,
        response: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          headers: error.response.headers,
        } : 'No response',
        requestHeaders: error.config?.headers,
      });
    } else {
      console.error(`Fetch error for ${url}:`, error);
    }
    throw error;
  });

  // Try to detect charset from headers or content
  const contentType = response.headers['content-type'] || '';
  let charset = 'euc-kr';

  const charsetMatch = contentType.match(/charset=([a-zA-Z0-9_-]+)/i);
  if (charsetMatch) {
    charset = charsetMatch[1].toLowerCase();
  }

  // Decode using iconv-lite
  try {
    return iconv.decode(Buffer.from(response.data), charset);
  } catch {
    // Fallback to cp949 if euc-kr fails
    try {
      return iconv.decode(Buffer.from(response.data), 'cp949');
    } catch {
      return iconv.decode(Buffer.from(response.data), 'utf-8');
    }
  }
}

// Normalize whitespace
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Extract seqno from onclick or href
function extractSeqno(element: cheerio.Cheerio<any>): string {
  const onclick = element.attr('onclick') || '';
  const href = element.attr('href') || '';

  const seqnoPattern = /f_go_location\s*\(\s*['"]?(\d+)['"]?\s*\)/i;

  let match = onclick.match(seqnoPattern);
  if (match) return match[1];

  match = href.match(seqnoPattern);
  if (match) return match[1];

  return '';
}

// Check if table is the notice list table
function isNoticeListTable($: cheerio.CheerioAPI, table: cheerio.Cheerio<any>): boolean {
  const firstRow = table.find('tr').first();
  const headers = firstRow.find('th').map((_, el) => normalize($(el).text())).get();

  if (headers.length === 0) return false;

  const matchCount = headers.filter(h => LIST_HEADER_KEYWORDS.includes(h)).length;
  return matchCount >= 3;
}

// Find the notice list table
function findNoticeListTable($: cheerio.CheerioAPI): cheerio.Cheerio<any> | null {
  const tables = $('table').toArray();
  const candidates = tables
    .map(t => $(t))
    .filter(t => isNoticeListTable($, t));

  if (candidates.length === 0) return null;

  // Return the table with the most rows
  candidates.sort((a, b) => b.find('tr').length - a.find('tr').length);
  return candidates[0];
}

// Check if table has "no result" message
function hasNoResult($: cheerio.CheerioAPI, table: cheerio.Cheerio<any>): boolean {
  const text = normalize(table.text());
  return NO_RESULT_PATTERNS.some(pattern => text.includes(pattern));
}

// Parse notice list table
function parseNoticeListTable($: cheerio.CheerioAPI, table: cheerio.Cheerio<any>): NoticeRow[] {
  if (hasNoResult($, table)) return [];

  const rows: NoticeRow[] = [];
  const firstRow = table.find('tr').first();
  const headers = firstRow.find('th').map((_, el) => normalize($(el).text())).get();

  table.find('tr').slice(1).each((_, tr) => {
    const $tr = $(tr);
    const cells = $tr.find('td, th').map((_, el) => normalize($(el).text())).get();

    if (cells.length === 0) return;

    const joinedText = cells.join(' ');
    if (NO_RESULT_PATTERNS.some(pattern => joinedText.includes(pattern))) return;
    if (cells.every(c => !c)) return;

    // Extract seqno
    let seqno = '';
    $tr.find('td').each((_, td) => {
      const $td = $(td);
      const onclick = $td.attr('onclick');
      if (onclick && !seqno) {
        seqno = extractSeqno($td);
      }
    });

    if (!seqno) {
      $tr.find('a').each((_, a) => {
        if (!seqno) {
          seqno = extractSeqno($(a));
        }
      });
    }

    const row: NoticeRow = {
      seqno,
      notice_url: seqno ? `${VIEW_URL}?seqno=${seqno}` : '',
    };

    headers.forEach((header, i) => {
      if (header && cells[i] !== undefined) {
        row[header] = cells[i];
      }
    });

    // Add any extra cells as col_N
    for (let i = headers.length; i < cells.length; i++) {
      row[`col_${i}`] = cells[i];
    }

    rows.push(row);
  });

  return rows;
}

// Extract total page count
function extractTotalPages($: cheerio.CheerioAPI): number {
  const text = $.text();

  // Look for "N page / M" pattern
  const pageMatch = text.match(/\b\d+\s*page\s*\/\s*(\d+)\b/i);
  if (pageMatch) {
    return parseInt(pageMatch[1], 10);
  }

  // Look for "총 N건" pattern and calculate pages
  const countMatch = text.match(/총\s*([\d,]+)\s*건/);
  if (countMatch) {
    const totalCount = parseInt(countMatch[1].replace(/,/g, ''), 10);
    // Assume 10 rows per page (adjust based on actual site behavior)
    return Math.max(1, Math.ceil(totalCount / 10));
  }

  return 1;
}

// Crawl a single list page
export async function crawlListPage(
  fromDate: Date,
  toDate: Date,
  page: number = 1
): Promise<CrawlListResult> {
  const params = buildQueryParams(fromDate, toDate, page);
  const html = await fetchHtml(BASE_URL, params);
  const $ = cheerio.load(html);

  const table = findNoticeListTable($);
  if (!table) {
    return { data: [], totalPages: 1, currentPage: page };
  }

  const data = parseNoticeListTable($, table);
  const totalPages = page === 1 ? extractTotalPages($) : 1;

  return { data, totalPages, currentPage: page };
}

// Extract location from detail page
export function extractLocationFromDetail(detailText: string): string {
  if (!detailText) return '';

  const normalized = normalize(detailText);

  // Pattern: "소재지 : <location> 업종:" or "소재지 : <location> 처분업종:"
  const pattern1 = /소재지\s*:\s*(.*?)\s*(?=(업종|처분업종)\s*:)/;
  const match1 = normalized.match(pattern1);
  if (match1) return normalize(match1[1]);

  // Fallback pattern
  const pattern2 = /소재지\s*:\s*(.*?)(?=\s*[가-힣A-Za-z0-9ㆍ()]+\s*:)/;
  const match2 = normalized.match(pattern2);
  if (match2) return normalize(match2[1]);

  return '';
}

// Fetch detail page
export async function fetchDetailPage(seqno: string, url: string): Promise<{
  seqno: string;
  detail_text: string;
  detail_location: string;
  detail_ok: boolean;
  detail_error?: string;
}> {
  if (!url) {
    return {
      seqno,
      detail_text: '',
      detail_location: '',
      detail_ok: false,
      detail_error: 'missing_url',
    };
  }

  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    // Try multiple selectors for detail content
    const selectors = [
      'ul.bl3x.mglt25.clr',
      'div.subcon ul',
      'div.subcon',
    ];

    let detailText = '';
    for (const selector of selectors) {
      const element = $(selector);
      if (element.length > 0) {
        detailText = normalize(element.text());
        if (detailText) break;
      }
    }

    const detailLocation = extractLocationFromDetail(detailText);

    return {
      seqno,
      detail_text: detailText,
      detail_location: detailLocation,
      detail_ok: !!detailText,
      detail_error: detailText ? undefined : 'empty_detail_text',
    };
  } catch (error) {
    return {
      seqno,
      detail_text: '',
      detail_location: '',
      detail_ok: false,
      detail_error: error instanceof Error ? error.message : 'unknown_error',
    };
  }
}
