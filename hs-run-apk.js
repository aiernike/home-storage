'use strict';
/* 临时运行器（仅本沙箱用）：先劫持 spawnSync，再原样加载 build-apk.js */
require('./hs-syncshim.js').patch();
require('./mobile/build-apk.js');
