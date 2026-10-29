// Worker chạy trên MÁY BẠN: node worker/worker.mjs
// Hỏi hệ thống (Vercel) xem có việc "viết nội dung" nào không → nhờ Chat Muse viết ngay trên máy này → gửi bản nháp về chờ bạn duyệt.
// Cookie Muse nằm trong thư mục data của Muse Studio trên máy bạn và KHÔNG được gửi đi đâu. Chỉ gửi đi: prompt đã nhận và JSON kết quả.
//
// Biến môi trường:
//   API_BASE            địa chỉ hệ thống, ví dụ https://ten-du-an.vercel.app (mặc định http://127.0.0.1:3700)
//   WORKER_TOKEN        khớp WORKER_TOKEN trên máy chủ (bắt buộc, ≥ 16 ký tự)
//   MUSE_STUDIO_DIR     thư mục tool Muse Studio để dùng lại lib/muse.js và cookie (mặc định ../../museinsight)
//   POLL_SECONDS        chu kỳ hỏi việc (mặc định 60)    MUSE_HEADLESS=1  ẩn cửa sổ trình duyệt
//   LOCAL_MODEL         đặt "template" để không dùng Muse (chỉ để thử luồng)
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Tách khối JSON đầu tiên cân bằng ngoặc và có khóa `key` (Muse là agent trò chuyện nên có thể kèm lời dẫn hoặc ```json).
export function extractJson(text, key = 'title') {
  const source = String(text || '');
  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0; let inString = false; let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue; }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try { const value = JSON.parse(source.slice(start, i + 1)); if (value && typeof value === 'object' && key in value) return value; } catch { /* thử ứng viên kế tiếp */ }
          break;
        }
      }
    }
  }
  return null;
}

// Xử lý một việc: ask(prompt) trả về văn bản của AI. Ném lỗi có `retry=false` cho lỗi không thể thử lại (hết cookie, hết quota).
export async function runJob(job, ask) {
  let text;
  try { text = await ask(job.prompt); } catch (error) { const wrapped = new Error(error.message || 'AI không trả lời được.'); wrapped.retry = !['AUTH_REQUIRED', 'QUOTA'].includes(error.code); throw wrapped; }
  const result = extractJson(text, 'title');
  if (!result || typeof result.body !== 'string') { const error = new Error('AI trả lời không đúng định dạng JSON {"title","body"}.'); error.retry = true; throw error; }
  return { title: String(result.title), body: String(result.body) };
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const base = (process.env.API_BASE || 'http://127.0.0.1:3700').replace(/\/+$/, '');
  const token = process.env.WORKER_TOKEN || '';
  const workerId = `worker-${(process.env.COMPUTERNAME || process.env.HOSTNAME || 'local').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20)}`;
  const poll = Math.max(15, Number(process.env.POLL_SECONDS || 60)) * 1000;
  if (token.length < 16) { console.error('Thiếu WORKER_TOKEN (≥ 16 ký tự).'); process.exit(1); }

  const call = async (body) => {
    const response = await fetch(`${base}/api/worker`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ workerId, ...body }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `Máy chủ trả lỗi ${response.status}`);
    return data.data;
  };

  let ask;
  if (process.env.LOCAL_MODEL === 'template') {
    ask = async () => JSON.stringify({ title: 'Bản nháp thử từ worker', body: 'Nội dung thử, chưa dùng AI. Hãy xóa bản nháp này.' });
  } else {
    const dir = path.resolve(process.env.MUSE_STUDIO_DIR || path.join(here, '..', '..', 'museinsight'));
    const require = createRequire(pathToFileURL(path.join(dir, 'package.json')));
    const muse = require(path.join(dir, 'lib', 'muse.js')).createProvider({ dataDir: path.join(dir, 'data') });
    if (!muse.credentialInfo().configured) { console.error('Chưa có cookie Muse: dán cookie trong Cài đặt của Muse Studio rồi chạy lại.'); process.exit(1); }
    ask = async (prompt) => (await muse.chat({ prompt, fresh: true, headless: process.env.MUSE_HEADLESS === '1', timeoutMs: 150000 })).text;
    process.on('SIGINT', async () => { await muse.stop(); process.exit(0); });
  }

  console.log(`Worker ${workerId} → ${base} (hỏi việc mỗi ${poll / 1000}s). Ctrl+C để dừng.`);
  for (;;) {
    try {
      const { job, reason } = await call({ action: 'claim' });
      if (job) {
        console.log(`Nhận việc ${job.id} (${job.channel})…`);
        try {
          const result = await runJob(job, ask);
          const done = await call({ action: 'complete', jobId: job.id, result });
          console.log(`  → bản nháp ${done.content.id}: ${done.content.status === 'PENDING_APPROVAL' ? 'chờ duyệt' : 'giữ ở nháp (chưa qua kiểm tra chất lượng)'}`);
        } catch (error) {
          console.error(`  ✗ ${error.message}`);
          await call({ action: 'fail', jobId: job.id, error: error.message, retry: error.retry !== false }).catch(() => {});
        }
        continue; // còn việc thì làm tiếp ngay
      }
      if (reason === 'kill_switch') console.log('Công tắc dừng khẩn cấp đang bật; chờ.');
    } catch (error) { console.error(`Không gọi được hệ thống: ${error.message}`); }
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
