import { receive } from './receive.js';
// Arguments contain local paths and chat id only. No remote plaintext or token.
const [root, chat, binary, relay, wait] = process.argv.slice(2);
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
try {
  const result = await receive({root, chat, binary, relay, wait, signal: controller.signal});
  process.stdout.write(JSON.stringify(result));
  if (['failed','canceled'].includes(result.outcome)) process.exitCode = 1;
} catch {
  process.stdout.write(JSON.stringify({outcome: 'failed'}));
  process.exitCode = 1;
}
