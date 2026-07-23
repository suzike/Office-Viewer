import { readdir, readFile, stat } from 'node:fs/promises'
import { join, parse } from 'node:path'
import type { DesktopMarkdownTemplate } from '../shared/desktop-api'

const MAX_USER_TEMPLATES = 32
const MAX_TEMPLATE_CHARS = 256 * 1024

const BUILT_IN_TEMPLATES: readonly DesktopMarkdownTemplate[] = [
  {
    id: 'builtin:blank',
    name: '空白文档',
    content: '',
  },
  {
    id: 'builtin:meeting',
    name: '会议纪要',
    content: [
      '# 会议纪要',
      '',
      '- 日期：',
      '- 参会人：',
      '- 记录人：',
      '',
      '## 议题',
      '',
      '1. ',
      '',
      '## 讨论要点',
      '',
      '- ',
      '',
      '## 结论与行动项',
      '',
      '- [ ] （负责人 / 截止时间）',
      '',
    ].join('\n'),
  },
  {
    id: 'builtin:weekly-report',
    name: '周报',
    content: [
      '# 周报（YYYY-MM-DD ~ YYYY-MM-DD）',
      '',
      '## 本周完成',
      '',
      '- ',
      '',
      '## 进行中',
      '',
      '- ',
      '',
      '## 遇到的问题',
      '',
      '- ',
      '',
      '## 下周计划',
      '',
      '- ',
      '',
    ].join('\n'),
  },
  {
    id: 'builtin:readme',
    name: 'README',
    content: [
      '# 项目名称',
      '',
      '一句话简介。',
      '',
      '## 功能特性',
      '',
      '- ',
      '',
      '## 安装',
      '',
      '```bash',
      '',
      '```',
      '',
      '## 使用方法',
      '',
      '## 许可证',
      '',
      'MIT',
      '',
    ].join('\n'),
  },
]

/**
 * Markdown 模板库：内置模板 + 用户自定义模板（userData/markdown-templates
 * 目录下的 .md 文件，文件名即模板名）。模板内容由「从模板插入」入口
 * 整体替换当前文档并标记为未保存。
 */
export class MarkdownTemplateService {
  public constructor(private readonly userDataRoot: string) {}

  public async list(): Promise<readonly DesktopMarkdownTemplate[]> {
    return [...BUILT_IN_TEMPLATES, ...await this.readUserTemplates()]
  }

  private async readUserTemplates(): Promise<DesktopMarkdownTemplate[]> {
    const directory = join(this.userDataRoot, 'markdown-templates')
    let entries: string[]
    try {
      entries = (await readdir(directory)).filter((name) => /\.(?:md|markdown)$/i.test(name)).slice(0, MAX_USER_TEMPLATES)
    } catch {
      return []
    }
    const templates: DesktopMarkdownTemplate[] = []
    for (const entry of entries) {
      const filePath = join(directory, entry)
      try {
        const fileStat = await stat(filePath)
        if (!fileStat.isFile() || fileStat.size > MAX_TEMPLATE_CHARS * 2) continue
        const content = await readFile(filePath, 'utf8')
        if (content.length > MAX_TEMPLATE_CHARS) continue
        templates.push({ id: `user:${entry}`, name: parse(entry).name, content })
      } catch {
        // Skip unreadable template files.
      }
    }
    return templates
  }
}
