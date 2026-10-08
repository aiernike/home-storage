'use strict';
// 群晖 compose 配置静态校验（无需 docker 环境）
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'server');
const files = ['synology-compose.yml', 'synology-compose-simple.yml'];

let bad = 0;

for (const f of files) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) {
    console.log(`  FAIL  ${f} 不存在`);
    bad++;
    continue;
  }
  const t = fs.readFileSync(p, 'utf8');
  const lines = t.split('\n');
  const errs = [];

  lines.forEach((l, i) => {
    if (l.includes('\t')) errs.push(`第 ${i + 1} 行含 tab`);
  });

  // 群晖界面不加载 .env，不能出现 ${VAR} 形式
  const varMatches = t.match(/\$\{[A-Z_]+\}/g);
  if (varMatches) errs.push('含变量引用 ' + varMatches.join(',') + '（群晖界面取不到值）');

  ['services:', 'networks:'].forEach((k) => {
    if (!t.includes(k)) errs.push('缺少顶层键 ' + k);
  });
  ['  db:', '  api:'].forEach((k) => {
    if (!t.includes(k)) errs.push('缺少服务 ' + k.trim());
  });

  // 端口映射存在
  if (!/ports:/.test(t)) errs.push('缺少端口映射');
  if (!/8787/.test(t)) errs.push('缺少 8787 端口');

  // 健康检查（db 服务）
  if (!/healthcheck:/.test(t)) errs.push('缺少数据库健康检查');

  // 挂载路径必须是绝对路径（群晖用 /volume1/...）
  // 只在 volumes: 段落下检查，避免把 ports 的 "8787:8787" 误判
  let inVolumes = false;
  lines.forEach((l, i) => {
    if (/^\s*volumes:\s*$/.test(l)) {
      inVolumes = true;
      return;
    }
    if (inVolumes) {
      // 遇到同级或更浅的键，说明 volumes 段结束
      if (/^\s{0,4}\w/.test(l) && !/^\s{6,}-/.test(l) && !/^\s*-/.test(l)) {
        inVolumes = false;
        return;
      }
      const m = l.match(/^\s+- (\S+):/);
      if (m) {
        const hostPath = m[1];
        if (!hostPath.startsWith('/')) {
          errs.push(`第 ${i + 1} 行挂载路径非绝对路径: ${hostPath}`);
        }
      }
    }
  });

  if (errs.length) {
    console.log(`  FAIL  ${f}`);
    errs.forEach((e) => console.log(`          · ${e}`));
    bad++;
  } else {
    const svc = (t.match(/^  \w+:/gm) || []).length;
    const vols2 = (t.match(/^\s+- \//gm) || []).length;
    console.log(`  PASS  ${f}  (${svc} 个服务, ${vols2} 个挂载点)`);
  }
}

// 与原配置对比，确认变量已替换
const orig = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
const simple = fs.readFileSync(path.join(dir, 'synology-compose-simple.yml'), 'utf8');
const sameImage = orig.includes('postgres:16-alpine') && simple.includes('postgres:16-alpine');
console.log(sameImage ? '  PASS  数据库镜像版本与主配置一致' : '  FAIL  镜像版本不一致');
if (!sameImage) bad++;

console.log(bad ? `\n  ${bad} 项有问题` : '\n  群晖配置文件校验通过');
process.exit(bad ? 1 : 0);
