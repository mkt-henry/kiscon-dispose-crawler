'use client';

import { useState } from 'react';
import * as XLSX from 'xlsx';

interface NoticeRow {
  seqno: string;
  notice_url: string;
  [key: string]: string;
}

interface DetailResult {
  seqno: string;
  detail_text: string;
  detail_location: string;
  detail_ok: boolean;
  detail_error?: string;
}

export default function Home() {
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    return d.toISOString().split('T')[0];
  });

  const [endDate, setEndDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  });

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [data, setData] = useState<NoticeRow[]>([]);
  const [fetchDetail, setFetchDetail] = useState(true);
  const [selectedFilters, setSelectedFilters] = useState<string[]>([]);

  const dispositionColumn = data.length > 0
    ? Object.keys(data[0]).find(k => k.includes('처분') && k.includes('내용'))
    : null;

  const dispositionOptions = dispositionColumn
    ? Array.from(new Set(data.map(row => row[dispositionColumn]).filter(v => v && v.trim())))
      .sort()
    : [];

  const filteredData = selectedFilters.length > 0 && dispositionColumn
    ? data.filter(row => selectedFilters.includes(row[dispositionColumn]))
    : data;

  const handleSearch = async () => {
    setSelectedFilters([]);
    setLoading(true);
    setProgress('검색 시작...');
    setData([]);

    try {
      const firstPageRes = await fetch('/api/crawl/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, page: 1 }),
      });

      if (!firstPageRes.ok) {
        let errorMessage = 'Failed to fetch first page';
        try {
          const errorData = await firstPageRes.json();
          errorMessage = `오류: ${errorData.error || firstPageRes.statusText}`;
          if (errorData.details) console.error('Detailed error:', errorData.details);
        } catch {
          errorMessage = `HTTP 오류: ${firstPageRes.status} ${firstPageRes.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const firstPageData = await firstPageRes.json();
      const { data: firstPageRows, totalPages } = firstPageData;

      if (firstPageRows.length === 0) {
        setProgress('검색 결과가 없습니다.');
        setLoading(false);
        return;
      }

      let allRows = [...firstPageRows];
      setProgress(`페이지 1/${totalPages} 완료 (${allRows.length}건)`);

      for (let page = 2; page <= totalPages; page++) {
        const pageRes = await fetch('/api/crawl/list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, page }),
        });

        if (pageRes.ok) {
          const pageData = await pageRes.json();
          allRows = [...allRows, ...pageData.data];
          setProgress(`페이지 ${page}/${totalPages} 완료 (${allRows.length}건)`);
        } else {
          setProgress(`페이지 ${page}/${totalPages} 실패 (계속 진행)`);
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (fetchDetail && allRows.length > 0) {
        setProgress(`상세 정보 수집 중... (0/${allRows.length})`);

        const detailPromises = allRows.map(async (row, index) => {
          if (!row.seqno || !row.notice_url) return null;

          try {
            const detailRes = await fetch('/api/crawl/detail', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ seqno: row.seqno, url: row.notice_url }),
            });

            if (detailRes.ok) {
              const detail: DetailResult = await detailRes.json();
              setProgress(`상세 정보 수집 중... (${index + 1}/${allRows.length})`);
              return detail;
            }
          } catch (error) {
            console.error(`Failed to fetch detail for ${row.seqno}:`, error);
          }
          return null;
        });

        const batchSize = 5;
        const details: (DetailResult | null)[] = [];

        for (let i = 0; i < detailPromises.length; i += batchSize) {
          const batch = detailPromises.slice(i, i + batchSize);
          const batchResults = await Promise.all(batch);
          details.push(...batchResults);
          setProgress(`상세 정보 수집 중... (${Math.min(i + batchSize, allRows.length)}/${allRows.length})`);
        }

        allRows = allRows.map((row, index) => {
          const detail = details[index];
          if (detail && detail.detail_ok) {
            return {
              ...row,
              상세소재지: detail.detail_location,
              detail_text: detail.detail_text,
            };
          }
          return row;
        });
      }

      setData(allRows);
      setProgress(`완료: ${allRows.length}건 수집`);
    } catch (error) {
      console.error('Search error:', error);
      setProgress(`오류: ${error instanceof Error ? error.message : '알 수 없는 오류'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleExportCSV = () => {
    if (filteredData.length === 0) return;

    const exportData = filteredData.map(row => {
      const { detail_text, ...rest } = row;
      return rest;
    });

    const csv = [
      Object.keys(exportData[0]).join(','),
      ...exportData.map(row =>
        Object.values(row).map(v => `"${String(v).replace(/"/g, '""')}`).join(',')
      ),
    ].join('\n');

    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    const suffix = selectedFilters.length > 0 ? '_filtered' : '';
    link.download = `kiscon_${startDate}_${endDate}${suffix}.csv`;
    link.click();
  };

  const handleExportExcel = () => {
    if (filteredData.length === 0) return;

    const exportData = filteredData.map(row => {
      const { detail_text, ...rest } = row;
      return rest;
    });

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'KISCON');
    const suffix = selectedFilters.length > 0 ? '_filtered' : '';
    XLSX.writeFile(wb, `kiscon_${startDate}_${endDate}${suffix}.xlsx`);
  };

  const columns = filteredData.length > 0 ? Object.keys(filteredData[0]).filter(k => k !== 'detail_text') : [];

  const handleFilterToggle = (value: string) => {
    setSelectedFilters(prev =>
      prev.includes(value)
        ? prev.filter(v => v !== value)
        : [...prev, value]
    );
  };

  return (
    <div className="min-h-screen p-6 md:p-12">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-3 tracking-tight">
            KISCON 공고 크롤러
          </h1>
          <p className="text-base opacity-60">
            건설업 처분 공고 검색
          </p>
        </div>

        {/* Search Controls */}
        <div className="glass-card p-6 md:p-8 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium mb-2 opacity-70">시작일</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg bg-transparent border border-current/20 focus:border-current"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2 opacity-70">종료일</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg bg-transparent border border-current/20 focus:border-current"
              />
            </div>

            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fetchDetail}
                  onChange={(e) => setFetchDetail(e.target.checked)}
                  className="w-4 h-4 rounded cursor-pointer"
                />
                <span className="text-sm font-medium">상세 내용 수집</span>
              </label>
            </div>

            <div className="flex items-end">
              <button
                onClick={handleSearch}
                disabled={loading}
                className="w-full px-6 py-2.5 bg-white text-black font-semibold rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? '검색 중...' : '검색'}
              </button>
            </div>
          </div>

          {progress && (
            <div className="mt-4 p-4 rounded-lg border border-current/10 bg-current/5">
              <p className="text-sm opacity-80">{progress}</p>
            </div>
          )}
        </div>

        {/* Results */}
        {data.length > 0 && (
          <>
            {/* Filter Section */}
            {dispositionColumn && dispositionOptions.length > 0 && (
              <div className="glass-card p-6 mb-6">
                <h3 className="text-lg font-semibold mb-4">처분내용 필터</h3>
                <div className="flex flex-wrap gap-2 mb-4">
                  {dispositionOptions.map((option) => (
                    <button
                      key={option}
                      onClick={() => handleFilterToggle(option)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border ${selectedFilters.includes(option)
                        ? 'bg-white text-black border-white'
                        : 'border-current/20 hover:border-current/40'
                        }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                {selectedFilters.length > 0 && (
                  <div className="flex items-center justify-between pt-4 border-t border-current/10">
                    <p className="text-sm opacity-60">
                      {selectedFilters.length}개 필터 선택됨
                    </p>
                    <button
                      onClick={() => setSelectedFilters([])}
                      className="text-sm font-medium underline opacity-60 hover:opacity-100"
                    >
                      초기화
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Export Buttons */}
            <div className="glass-card p-6 mb-6">
              <div className="flex flex-wrap gap-3 items-center">
                <button
                  onClick={handleExportCSV}
                  disabled={filteredData.length === 0}
                  className="px-5 py-2 border border-current/20 rounded-lg font-medium disabled:opacity-30 hover:border-current/40"
                >
                  CSV 다운로드
                </button>
                <button
                  onClick={handleExportExcel}
                  disabled={filteredData.length === 0}
                  className="px-5 py-2 border border-current/20 rounded-lg font-medium disabled:opacity-30 hover:border-current/40"
                >
                  Excel 다운로드
                </button>
                <div className="ml-auto flex items-center gap-4 text-sm opacity-60">
                  {selectedFilters.length > 0 && (
                    <span>필터링: {filteredData.length}건</span>
                  )}
                  <span>전체: {data.length}건</span>
                </div>
              </div>
            </div>

            {/* Data Table */}
            <div className="glass-card p-6 overflow-hidden">
              {filteredData.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        {columns.map((col) => (
                          <th key={col} className="px-4 py-3 text-left font-semibold opacity-70">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredData.map((row, index) => (
                        <tr key={index}>
                          {columns.map((col) => (
                            <td key={col} className="px-4 py-3 opacity-80">
                              {col === 'notice_url' && row[col] ? (
                                <a
                                  href={row[col]}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="underline hover:opacity-60"
                                >
                                  링크
                                </a>
                              ) : (
                                row[col] || '-'
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-12 opacity-50">
                  <p>선택한 필터에 해당하는 결과가 없습니다.</p>
                </div>
              )}
            </div>
          </>
        )}

        {!loading && data.length === 0 && (
          <div className="glass-card p-12 text-center opacity-60">
            <p className="text-lg">날짜를 선택하고 검색 버튼을 눌러주세요</p>
          </div>
        )}
      </div>
    </div>
  );
}
