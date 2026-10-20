'use strict';

const C = {
  toast(msg, type = 'ok', ms = 2600) {
    const root = document.getElementById('toastRoot');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .2s';
      setTimeout(() => el.remove(), 220);
    }, ms);
  },

  confirm(message, { title = '请确认', okText = '确定', danger = false } = {}) {
    return new Promise((resolve) => {
      const box = document.getElementById('modalBox');
      box.className = 'modal-box';
      box.innerHTML = `
        <div class="modal-head"><div class="modal-title">${U.esc(title)}</div>
          <button class="modal-close" data-act="close">✕</button></div>
        <div class="modal-body"><div style="line-height:1.7">${U.esc(message).replace(/\n/g, '<br>')}</div></div>
        <div class="modal-foot">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${U.esc(okText)}</button>
        </div>`;
      C._open();
      const done = (v) => {
        C.close();
        resolve(v);
      };
      box.querySelector('[data-act="close"]').onclick = () => done(false);
      box.querySelector('[data-act="cancel"]').onclick = () => done(false);
      box.querySelector('[data-act="ok"]').onclick = () => done(true);
    });
  },

  /**
   * 通用表单弹窗
   * fields: [{ key, label, type, value, options, required, placeholder, hint, full, min, max, step, attrs }]
   * onSubmit(values) 返回 false 可阻止关闭；抛错会显示错误
   */
  form({ title, fields, okText = '保存', wide = false, onSubmit, extraHtml = '', onMount, compactHints = false }) {
    return new Promise((resolve) => {
      const box = document.getElementById('modalBox');
      box.className = 'modal-box' + (wide ? ' wide' : '');
      /**
       * compactHints（方案 E）：把字段说明从「压在字段下面的一行灰字」收进「?」里。
       * 7 个字段配 7 行说明，弹窗显得又长又啰嗦 —— 但说明本身不能删，
       * 所以收起来而不是扔掉：桌面悬停有 title，手机点「?」展开。
       * ⚠️ 只给物品编辑器开（那里字段最多）。别的表单字段少，灰字摊开更直接。
       */
      const renderField = (f) => {
        const v = f.value == null ? '' : f.value;
        const cls = f.full ? 'form-row full' : 'form-row';
        const help = compactHints && f.hint
          ? `<span class="form-help" data-help-for="${f.key}" title="${U.esc(f.hint)}">?</span>`
          : '';
        const label = `<label class="form-label">${U.esc(f.label)}${f.required ? '<span class="req">*</span>' : ''}${help}</label>`;
        const hintHtml = f.hint
          ? `<div class="form-hint"${compactHints ? ' hidden' : ''} data-hint-for="${f.key}">${U.esc(f.hint)}</div>`
          : '';
        let input;
        if (f.type === 'select') {
          const opts = (f.options || [])
            .map((o) => {
              const val = typeof o === 'string' ? o : o.value;
              const lab = typeof o === 'string' ? o : o.label;
              return `<option value="${U.esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${U.esc(lab)}</option>`;
            })
            .join('');
          input = `<select class="select input-full" data-k="${f.key}" ${f.attrs || ''}>${opts}</select>`;
        } else if (f.type === 'textarea') {
          input = `<textarea class="input input-full" data-k="${f.key}" rows="${f.rows || 3}" placeholder="${U.esc(f.placeholder || '')}" ${f.attrs || ''}>${U.esc(v)}</textarea>`;
        } else if (f.type === 'static') {
          input = `<div class="form-hint" style="padding:7px 0">${f.html || ''}</div>`;
        } else if (f.type === 'dateshort') {
          /**
           * 日期速记输入框。刻意用 type="text" 而不是 type="date"：
           * 原生日期选择器只认完整日期，没法输入「+1m」这种速记；而且它的显示格式
           * 跟着系统语言走（中文 Windows 上是 2026/9/19），和别处显示的 2026-09-19 对不上。
           * 速记的解析在 blur 和提交两处做（见 normalizeDateShort）。
           */
          input =
            `<input class="input input-full" data-k="${f.key}" type="text" autocomplete="off" ` +
            `value="${U.esc(v)}" placeholder="${U.esc(f.placeholder || '如 2026-05-17，或 +1m / 30天 / 0517 / x')}" ` +
            `${f.attrs || ''}>` +
            `<div class="form-hint" data-ds-hint="${f.key}"></div>`;
        } else {
          input = `<input class="input input-full" data-k="${f.key}" type="${f.type || 'text'}"
            value="${U.esc(v)}" placeholder="${U.esc(f.placeholder || '')}"
            ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''}
            ${f.step != null ? `step="${f.step}"` : ''} ${f.attrs || ''}>`;
        }
        return `<div class="${cls}">${label}${input}${hintHtml}</div>`;
      };

      box.innerHTML = `
        <div class="modal-head"><div class="modal-title">${U.esc(title)}</div>
          <button class="modal-close" data-act="close">✕</button></div>
        <div class="modal-body">
          <form class="form-grid" id="modalForm">${fields.map(renderField).join('')}</form>
          ${extraHtml}
          <div class="form-hint" id="formErr" style="color:var(--red);margin-top:10px;display:none"></div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn btn-primary" data-act="ok">${U.esc(okText)}</button>
        </div>`;

      C._open();
      // 「?」点一下展开/收起字段说明（方案 E）。手机上没有 hover，
      // 只给 title 等于「说明写了但永远看不到」，所以必须能点开。
      box.querySelectorAll('.form-help').forEach((h) => {
        h.onclick = () => {
          const t = box.querySelector(`[data-hint-for="${h.dataset.helpFor}"]`);
          if (!t) return;
          t.hidden = !t.hidden;
          h.classList.toggle('on', !t.hidden);
        };
      });
      const close = (v) => {
        C.close();
        resolve(v);
      };
      const errEl = box.querySelector('#formErr');

      /**
       * 日期速记字段归一化：把「+1m / 0517 / x」解析成 ISO 日期写回输入框，
       * 顺便在字段下方给一句「已理解为 2026-05-17」。
       *
       * 返回第一条错误信息（空串 = 全通过）。**提交时必须再跑一次**：
       * blur 只在用户真的离开输入框时才触发，而「填完直接点保存」「按回车提交」
       * 都可能不触发 blur，只靠 blur 归一化会漏 —— 那时存进去的就是「+1m」这串字。
       *
       * 只在 blur / 提交时归一化，不在 input 事件里改用户正在敲的内容：
       * 敲到第 3 个字符时本来就不构成合法日期，边敲边改写会让输入框自己跳。
       */
      const normalizeDateShort = () => {
        let firstErr = '';
        (fields || []).forEach((f) => {
          if (f.type !== 'dateshort') return;
          const el = box.querySelector(`[data-k="${f.key}"]`);
          if (!el) return;
          const hint = box.querySelector(`[data-ds-hint="${f.key}"]`);
          const raw = String(el.value || '').trim();
          const r = U.parseDateShorthand(raw);
          if (!r.ok) {
            if (hint) {
              hint.style.color = 'var(--red)';
              hint.textContent = `${r.reason}　可填：2026-05-17 / +1m / 30天 / 0517 / x（无期限）`;
            }
            if (!firstErr) firstErr = `${f.label}：${r.reason}`;
            return;
          }
          if (el.value !== r.date) el.value = r.date;
          if (hint) {
            hint.style.color = '';
            hint.textContent = r.date ? `已理解为 ${r.date}` : raw ? '已清空（表示没有期限）' : '';
          }
        });
        return firstErr;
      };

      const collect = () => {
        const out = {};
        box.querySelectorAll('[data-k]').forEach((el) => {
          out[el.dataset.k] = el.value;
        });
        return out;
      };

      box.querySelector('[data-act="close"]').onclick = () => close(null);
      box.querySelector('[data-act="cancel"]').onclick = () => close(null);
      box.querySelector('[data-act="ok"]').onclick = async () => {
        const dateErr = normalizeDateShort();
        if (dateErr) {
          errEl.textContent = dateErr;
          errEl.style.display = 'block';
          return;
        }
        errEl.style.display = 'none';
        const vals = collect();
        const missing = fields.find((f) => f.required && !String(vals[f.key] || '').trim());
        if (missing) {
          errEl.textContent = `请填写「${missing.label}」`;
          errEl.style.display = 'block';
          return;
        }
        try {
          const res = await onSubmit(vals);
          if (res === false) return;
          close(res === undefined ? vals : res);
        } catch (e) {
          errEl.textContent = String((e && e.message) || e);
          errEl.style.display = 'block';
        }
      };

      // 离开输入框时归一化，让用户当场看到「我写的 0517 变成了 2027-05-17」
      (fields || []).forEach((f) => {
        if (f.type !== 'dateshort') return;
        const el = box.querySelector(`[data-k="${f.key}"]`);
        if (!el) return;
        el.addEventListener('blur', normalizeDateShort);
        // 重新开始输入时先擦掉上一条红字，别让用户边打字边看着一个旧报错
        el.addEventListener('input', () => {
          const hint = box.querySelector(`[data-ds-hint="${f.key}"]`);
          if (hint && hint.style.color) {
            hint.style.color = '';
            hint.textContent = '';
          }
        });
      });

      const first = box.querySelector('.modal-body input, .modal-body select, .modal-body textarea');
      if (first) setTimeout(() => first.focus(), 50);

      box.querySelectorAll('[data-k]').forEach((el) => {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && el.tagName !== 'TEXTAREA') {
            e.preventDefault();
            box.querySelector('[data-act="ok"]').click();
          }
        });
      });

      if (onMount) onMount(box, close);
    });
  },

  /**
   * 通用内容弹窗：body 与按钮完全自定义（用于二维码这类非表单内容）
   * opts: { title, bodyHtml, footHtml, wide, onMount }
   */
  modal({ title, bodyHtml, footHtml = '', wide = false, onMount } = {}) {
    return new Promise((resolve) => {
      const box = document.getElementById('modalBox');
      box.className = 'modal-box' + (wide ? ' wide' : '');
      box.innerHTML = `
        <div class="modal-head"><div class="modal-title">${U.esc(title)}</div>
          <button class="modal-close" data-act="close">✕</button></div>
        <div class="modal-body">${bodyHtml}</div>
        ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}`;
      C._open();
      const close = (v) => {
        C.close();
        resolve(v);
      };
      box.querySelectorAll('[data-act="close"]').forEach((b) => {
        b.onclick = () => close(null);
      });
      if (onMount) onMount(box, close);
    });
  },

  _open() {
    document.getElementById('modalRoot').hidden = false;
  },

  close() {
    document.getElementById('modalRoot').hidden = true;
    document.getElementById('modalBox').innerHTML = '';
  },

  empty(icon, title, sub) {
    return `<div class="empty"><div class="empty-icon">${icon}</div>
      <div class="empty-title">${U.esc(title)}</div>
      ${sub ? `<div class="empty-sub">${U.esc(sub)}</div>` : ''}</div>`;
  },

  barcodeText(item) {
    const list = item.barcodes && item.barcodes.length ? item.barcodes : item.barcode ? [item.barcode] : [];
    if (!list.length) return '';
    return `<span class="tag tag-barcode">▥ ${U.esc(list[0])}${list.length > 1 ? ` +${list.length - 1}` : ''}</span>`;
  }
};

window.C = C;
