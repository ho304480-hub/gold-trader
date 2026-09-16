// Test harness for AnomalyDetector
const fs = require('fs');
const src = fs.readFileSync('public/app.js', 'utf8');

// Extract just the AnomalyDetector module
const start = src.indexOf('const AnomalyDetector');
const end = src.indexOf('// Inline mock candle generator');
const moduleCode = src.substring(start, end);

// Mock dependencies
const mockEscape = (s) => s;
const mockAnalyticsWidgets = {
  register: (id, title, fn, opts) => {
    console.log('Registered widget: ' + id);
  }
};

// Evaluate the module and capture the returned object
const AnomalyDetector = new Function(
  'escapeHtml',
  'AnalyticsWidgets',
  moduleCode + '\nreturn AnomalyDetector;'
)(mockEscape, mockAnalyticsWidgets);

// Test 1: Normal ticks should not trigger alerts
for (let i = 0; i < 20; i++) {
  AnomalyDetector.feedTick(2350 + Math.random() * 0.5, Date.now() + i * 100);
}
console.log('Test 1 - Tick count after normal feed: ' + AnomalyDetector.getTickCount());
console.log('Test 1 - Alerts after normal feed: ' + AnomalyDetector.getAlerts().length);

// Test 2: Price spike should trigger an alert
for (let i = 0; i < 5; i++) {
  AnomalyDetector.feedTick(2350 + Math.random() * 0.5, Date.now() + i * 100);
}
AnomalyDetector.feedTick(2360, Date.now() + 500);
console.log('Test 2 - Alerts after spike: ' + AnomalyDetector.getAlerts().length);
AnomalyDetector.getAlerts().forEach(a => console.log('  [' + a.severity + '] ' + a.message));

// Test 3: Clamping detection
AnomalyDetector.reset();
for (let i = 0; i < 10; i++) {
  AnomalyDetector.feedTick(2350.00, Date.now() + i * 100);
}
console.log('Test 3 - Alerts after clamping: ' + AnomalyDetector.getAlerts().length);
AnomalyDetector.getAlerts().forEach(a => console.log('  [' + a.severity + '] ' + a.message));

console.log('All tests passed!');