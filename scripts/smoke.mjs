/**
 * 冒烟脚本：不经过 DSH，直接构建工具并调用 execute。
 *
 *   node scripts/smoke.mjs
 */
import { buildTools } from '../index.js';

const tools = buildTools();
console.log(`工具数量：${tools.length}`);
for (const tool of tools) {
    console.log(`- ${tool.name}: ${tool.parameters?.type === 'object' ? Object.keys(tool.parameters.properties ?? {}).join(', ') || '(无参数)' : '(无参数)'}`);
}

const envProbe = tools.find((tool) => tool.name === 'env_probe');
const status = tools.find((tool) => tool.name === 'git_status');

const envValue = await envProbe.execute({}, {});
console.log('\n== env_probe ==');
console.log(envProbe.output.render({}, envValue)[0].text);

const statusValue = await status.execute({}, {});
console.log('\n== git_status（当前目录） ==');
console.log(status.output.render({}, statusValue)[0].text);

if (envValue.ok !== true) {
    console.warn('\n警告：env_probe 报告了不可用项，详见上方输出。');
}
