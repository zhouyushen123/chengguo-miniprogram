// utils/db.js —— 兼容垫片
//
// 数据层实现拆分在 utils/db/ 目录（入口 index.js）。
// 微信开发者工具的模块解析对「目录作模块」（require('./utils/db') → utils/db/index.js）
// 支持不稳定，会报 module 'utils/db.js' is not defined，
// 所以保留这个同名文件作为唯一入口，全部引用统一转发到目录实现。
module.exports = require('./db/index.js');
