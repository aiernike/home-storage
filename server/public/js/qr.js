'use strict';
/**
 * 二维码工具：生成 + 解析
 *
 * 生成复用 zxing.min.js 里自带的编码器 BrowserQRCodeSvgWriter（矢量 SVG，打印清晰），
 * 所以不需要再引入任何二维码库——桌面端和手机端共用同一份。
 *
 * 载荷格式（自定义前缀，便于扫码时区分「这是本应用的二维码」）：
 *   位置：HOMESTORAGE:LOC:<位置 id>
 *   物品：HOMESTORAGE:ITEM:<物品 id>
 * 扫码识别到这种前缀就按对应对象处理；否则当作普通条码走原有录入流程。
 */
(function () {
  var PREFIX = 'HOMESTORAGE:';
  var LOC = PREFIX + 'LOC:';
  var ITEM = PREFIX + 'ITEM:';

  var QR = {
    locPayload: function (id) {
      return LOC + String(id || '');
    },
    itemPayload: function (id) {
      return ITEM + String(id || '');
    },

    /** 解析扫码结果。命中本应用二维码返回 {type:'loc'|'item', id}，否则 null */
    parse: function (text) {
      var s = String(text == null ? '' : text).trim();
      var up = s.toUpperCase();
      if (up.indexOf(LOC) === 0) return { type: 'loc', id: s.slice(LOC.length) };
      if (up.indexOf(ITEM) === 0) return { type: 'item', id: s.slice(ITEM.length) };
      return null;
    },

    supported: function () {
      return typeof window !== 'undefined' && !!window.ZXing && !!window.ZXing.BrowserQRCodeSvgWriter;
    },

    /** 生成二维码 SVG 字符串（矢量，可打印） */
    svg: function (text, size) {
      size = size || 220;
      if (!QR.supported()) throw new Error('二维码组件未加载（js/zxing.min.js 缺失）');
      var el = new window.ZXing.BrowserQRCodeSvgWriter().write(String(text), size, size);
      var html = (el && el.outerHTML) || String(el);
      // 补 xmlns，方便单独当图片用（inline 到页面里则无所谓）
      if (html.indexOf('xmlns') < 0) {
        html = html.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      return html;
    },

    /** 生成二维码 data URL，可直接放进 <img src> */
    dataUrl: function (text, size) {
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(QR.svg(text, size));
    }
  };

  window.QR = QR;
})();
