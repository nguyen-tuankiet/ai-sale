// Tạo file bản cài để bán từ dự án tool ../museinsight: node release.mjs → release/muse-studio.zip (và muse-studio-pro.zip nếu có prompt-pack).
// Lấy từ commit HIỆN TẠI của museinsight (git archive) nên không có data/, cookie hay token. Loại docs, site, prompt-pack khỏi bản thường.
// Tải hai file này lên repo GitHub RIÊNG TƯ (RELEASE_REPO); không bao giờ đặt trong thư mục public/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tool = path.resolve(here, '..', 'museinsight');
const release = path.join(here, 'release');
fs.mkdirSync(release, { recursive: true });
if (!fs.existsSync(path.join(tool, '.git'))) { console.error(`Không thấy repo git của tool tại ${tool}`); process.exit(1); }

const zip = path.join(release, 'muse-studio.zip');
execFileSync('git', ['archive', '--format=zip', '--prefix=MuseStudio/', '-o', zip, 'HEAD', '--', '.', ':(exclude)docs', ':(exclude)site', ':(exclude)prompt-pack'], { cwd: tool, stdio: 'inherit' });
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(`muse-studio.zip  ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB  SHA-256 ${sha(zip)}`);

const packDist = path.join(tool, 'prompt-pack', 'dist');
if (fs.existsSync(path.join(packDist, 'Muse-Studio-Prompt-Pack.pdf'))) {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar';
  const stage = path.join(release, 'stage');
  fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
  execFileSync(tar, ['-xf', 'muse-studio.zip', '-C', 'stage'], { cwd: release, stdio: 'inherit' });
  fs.cpSync(packDist, path.join(stage, 'MuseStudio', 'Prompt-Pack'), { recursive: true });
  const proZip = path.join(release, 'muse-studio-pro.zip');
  fs.rmSync(proZip, { force: true });
  execFileSync(tar, ['-a', '-cf', 'muse-studio-pro.zip', '-C', 'stage', 'MuseStudio'], { cwd: release, stdio: 'inherit' });
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`muse-studio-pro.zip  ${(fs.statSync(proZip).size / 1048576).toFixed(1)} MB  SHA-256 ${sha(proZip)}`);
} else console.log('Chưa có prompt-pack/dist nên chưa tạo gói Pro: chạy `node prompt-pack/build.mjs` trong museinsight rồi chạy lại.');
