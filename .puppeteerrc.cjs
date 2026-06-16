const {join} = require('path');

module.exports = {
  // كنوجهو السيرفر فين يسطالي Chrome
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};