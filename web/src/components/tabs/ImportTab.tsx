import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, Download, AlertCircle } from 'lucide-react';
import { apiClient } from '../../lib/api';

interface ImportTabProps {
  eventId: string;
}

// Matches the backend ImportPreviewResponse shape (see app/schemas/import_preview.py).
interface ColumnMapping {
  excel_header: string;
  mapped_to: string | null;
  confidence: number;
}
interface PreviewData {
  total_rows: number;
  column_mappings: ColumnMapping[];
  sample_rows: Record<string, unknown>[];
  warnings: string[];
}

export function ImportTab({ eventId }: ImportTabProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [error, setError] = useState('');
  const queryClient = useQueryClient();

  const previewMutation = useMutation({
    mutationFn: async (file: File) => {
      return apiClient.previewImport(eventId, file);
    },
    onSuccess: (data) => {
      setPreviewData(data as PreviewData);
      setError('');
    },
    onError: (err) => {
      setError(
        err instanceof Error ? err.message : '预览失败，请检查文件格式'
      );
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      if (!previewData || !selectedFile) throw new Error('No preview data');
      // Build the column-mapping dict the backend expects from the
      // auto-detected mappings. Only include columns that mapped to a
      // known attendee field.
      const mappings: Record<string, string> = {};
      for (const m of previewData.column_mappings) {
        if (m.mapped_to) mappings[m.excel_header] = m.mapped_to;
      }
      return apiClient.confirmImport(eventId, selectedFile, mappings, true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendees'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setSelectedFile(null);
      setPreviewData(null);
      setError('');
      alert('导入成功！');
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : '导入失败');
    },
  });

  const handleFileSelect = async (file: File) => {
    setSelectedFile(file);
    setError('');
    previewMutation.mutate(file);
  };

  const handleConfirmImport = () => {
    if (confirm('确定要导入这些参会人吗？')) {
      confirmMutation.mutate();
    }
  };

  if (previewData) {
    // Derive the column list to render in the sample table. Use the
    // mapped fields when known; fall back to the raw excel header for
    // columns that didn't auto-map.
    const sampleColumns: { key: string; label: string; mapped: boolean }[] =
      previewData.column_mappings.map((m) => ({
        key: m.mapped_to || m.excel_header,
        label: m.excel_header,
        mapped: !!m.mapped_to,
      }));

    return (
      <div className="space-y-4">
        {/* Warnings — backend returns these as strings (duplicates, blanks, etc.) */}
        {previewData.warnings && previewData.warnings.length > 0 && (
          <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg flex gap-3">
            <AlertCircle className="text-yellow-600 flex-shrink-0" size={20} />
            <div className="text-sm text-yellow-800 space-y-1">
              <p className="font-medium">需要注意 ({previewData.warnings.length} 项)</p>
              <ul className="list-disc list-inside text-yellow-700 max-h-32 overflow-y-auto">
                {previewData.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
              {previewData.warnings.length > 20 && (
                <p className="text-xs">…还有 {previewData.warnings.length - 20} 条</p>
              )}
            </div>
          </div>
        )}

        {/* Column Mapping — read-only display of auto-detected mappings */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">列映射（自动识别）</h3>
          <div className="space-y-2">
            {previewData.column_mappings.map((m) => (
              <div key={m.excel_header} className="grid grid-cols-12 gap-3 items-center text-sm">
                <div className="col-span-5 text-gray-700 font-mono">{m.excel_header}</div>
                <div className="col-span-1 text-center text-gray-400">→</div>
                <div className="col-span-4 font-mono">
                  {m.mapped_to ? (
                    <span className="text-gray-900">{m.mapped_to}</span>
                  ) : (
                    <span className="text-gray-400 italic">（不映射）</span>
                  )}
                </div>
                <div className="col-span-2 text-right">
                  {m.mapped_to && (
                    <span className="text-xs text-gray-500">
                      置信 {(m.confidence * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Preview */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            预览数据（共 {previewData.total_rows} 行，显示前 {previewData.sample_rows.length} 行）
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {sampleColumns.map((c) => (
                    <th
                      key={c.key}
                      className={`px-4 py-2 text-left font-medium ${c.mapped ? 'text-gray-900' : 'text-gray-400'}`}
                      title={c.mapped ? `→ ${c.key}` : '未映射，不会导入'}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {previewData.sample_rows.map((row, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    {sampleColumns.map((c) => (
                      <td
                        key={`${idx}-${c.key}`}
                        className="px-4 py-2 text-gray-600"
                      >
                        {String(row[c.key] ?? '') || '-'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Actions */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="flex gap-3">
          <button
            onClick={() => {
              setPreviewData(null);
              setSelectedFile(null);
            }}
            className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors"
          >
            返回
          </button>
          <button
            onClick={handleConfirmImport}
            disabled={confirmMutation.isPending}
            className="flex-1 px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {confirmMutation.isPending ? '导入中...' : '确认导入'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Import Section */}
      <div className="bg-white rounded-lg shadow p-8">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">导入参会人</h3>
        <label className="block border-2 border-dashed border-gray-300 rounded-lg p-8 cursor-pointer hover:border-indigo-500 hover:bg-indigo-50 transition-colors text-center">
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                handleFileSelect(file);
              }
            }}
            disabled={previewMutation.isPending}
            className="hidden"
          />
          <Upload className="mx-auto mb-3 text-gray-400" size={40} />
          <p className="text-base font-medium text-gray-900 mb-1">
            上传 Excel 或 CSV 文件
          </p>
          <p className="text-sm text-gray-500">
            {selectedFile
              ? `已选择: ${selectedFile.name}`
              : '点击选择文件，支持 .xlsx, .xls, .csv'}
          </p>
        </label>

        {previewMutation.isPending && (
          <p className="text-gray-600 mt-3 text-center">处理中...</p>
        )}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 mt-3">
            {error}
          </div>
        )}
      </div>

      {/* Export Section */}
      <div className="bg-white rounded-lg shadow p-8">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">导出数据</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <a
            href={apiClient.getExportAttendeesUrl(eventId)}
            className="flex items-center gap-3 p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Download size={24} className="text-indigo-600" />
            <div>
              <p className="font-medium text-gray-900">导出参会人员</p>
              <p className="text-sm text-gray-500">
                包含姓名、职位、组织、状态、座位等信息
              </p>
            </div>
          </a>
          <a
            href={apiClient.getExportSeatmapUrl(eventId)}
            className="flex items-center gap-3 p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Download size={24} className="text-green-600" />
            <div>
              <p className="font-medium text-gray-900">导出座位图</p>
              <p className="text-sm text-gray-500">
                Excel 网格视图，展示各座位分配情况
              </p>
            </div>
          </a>
        </div>
      </div>
    </div>
  );
}
