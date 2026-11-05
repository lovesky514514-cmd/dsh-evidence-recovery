window.__ModuleLoader__.load({
  id: 'sky-evidence-recovery',
  factory(require) {
    const { createElement: h, useEffect, useState } = require('react')
    const css = [
      '.sky-web-wizard{box-sizing:border-box;height:370px;display:flex;flex-direction:column;',
      'gap:12px;padding:16px;background:#fbfaf6;color:#20322b;border:1px solid #deded2;border-radius:12px;',
      'font:14px/1.55 Inter,"Noto Sans SC","Microsoft YaHei",sans-serif}',
      '.sky-web-wizard h2,.sky-web-wizard p{margin:0}',
      '.sky-web-wizard h2{font:500 22px/1.35 Georgia,"Noto Serif SC","Songti SC",serif}',
      '.sky-web-wizard .sky-body{min-height:0;flex:1;overflow:auto;scrollbar-gutter:stable;padding-right:6px}',
      '.sky-web-wizard .sky-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.sky-web-wizard button{font:inherit;padding:6px 10px;border:1px solid #c5d0c4;border-radius:6px;',
      'background:#e8eee5;color:#20322b;cursor:pointer}',
      '.sky-web-wizard button[data-primary=true]{background:#244a3c;color:white}',
      '.sky-web-wizard button:disabled{opacity:.55;cursor:default}',
      '.sky-web-wizard :focus-visible{outline:2px solid #8c6b37;outline-offset:2px}',
      '.sky-web-wizard .sky-muted{color:#536458}',
      '.sky-web-wizard .sky-list{list-style:none;padding:0;margin:8px 0}',
      '.sky-web-wizard .sky-list li{padding:7px 0;border-bottom:1px solid #deded2}',
      '.sky-web-wizard .sky-list button{width:100%;text-align:left;overflow-wrap:anywhere}',
      '.sky-web-wizard form{display:grid;gap:7px;margin-top:8px}',
      '.sky-web-wizard label{display:grid;gap:2px}',
      '.sky-web-wizard input,.sky-web-wizard select,.sky-web-wizard textarea{font:inherit;color:#20322b;',
      'background:#fffdf7;border:1px solid #c5d0c4;border-radius:4px;padding:5px;width:100%;box-sizing:border-box}',
      '.sky-web-wizard pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:6px;background:#e8eee5}',
      '.sky-web-wizard .sky-record-id{overflow-wrap:anywhere}',
    ].join('')

    function button(label, onClick, primary = false, disabled = false) {
      return h('button', { type: 'button', onClick, 'data-primary': primary, disabled }, label)
    }

    const rpcErrors = {
      'sky/owner-required': '请从 DSH 所有者会话查看账本。',
      'remote-access/denied': '当前 DSH 会话没有读取账本的权限。',
      'gateway/peer-disposed': 'DSH 会话已失效。请重新连接后刷新。',
      'gateway/lookup-not-found': 'DSH 未找到向导接口。请确认插件已安装并启用。',
      'gateway/invocation-unavailable': '当前宿主没有挂载向导接口。请核对 DSH 版本和插件安装。',
      'gateway/service-unavailable': '向导宿主服务暂不可用。请确认插件已启用。',
      'gateway/internal': 'DSH 网关处理失败。请用诊断码核查宿主日志。',
    }

    function rpcErrorMessage(code) {
      return Object.hasOwn(rpcErrors, code)
        ? rpcErrors[code] + '（' + code + '）'
        : '无法读取插件状态。请检查 DSH 连接和当前会话权限。'
    }

    function Setup({ snapshot }) {
      const checks = [
        '插件已加载',
        snapshot.ledgerLocked ? '账本锁已持有' : '账本锁不可用。检查 DSH 实例和账本目录权限。',
        snapshot.protectedTools.length
          ? '已配置保护规则：' + snapshot.protectedTools.join('、')
          : '还没有保护规则。请在插件配置的 rules 中添加实际工具与稳定的 keyArg。',
        snapshot.invalidRules.length
          ? '需要修正规则：' + snapshot.invalidRules.map(name => name || '空工具名').join('、')
          : '未发现无效规则',
      ]
      return h('ul', { className: 'sky-list' }, checks.map(check => h('li', { key: check }, check)))
    }

    function Review({ record }) {
      const [decision, setDecision] = useState('')
      const [draft, setDraft] = useState({ source: '', observedAt: '', summary: '', reference: '' })
      const [exported, setExported] = useState(false)
      const filename = 'sky-readback-' + record.recordId.slice(0, 8) + '.json'
      const observed = Date.parse(draft.observedAt)
      const validTime = observed >= Date.parse(record.updatedAt) && observed <= Date.now()
      const reference = draft.reference.trim()
      const validReference = !reference || /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(reference)
      const canExport = Boolean(decision && draft.source.trim() && draft.observedAt &&
        draft.summary.trim().length >= 8 && validTime && validReference)
      function setField(name, value) {
        setDraft(previous => ({ ...previous, [name]: value }))
        setExported(false)
      }
      function exportEvidence() {
        const evidence = {
          source: draft.source.trim(),
          observedAt: new Date(draft.observedAt).toISOString(),
          summary: draft.summary.trim(),
        }
        if (reference) evidence.reference = reference
        const url = URL.createObjectURL(new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setExported(true)
      }
      function field(label, name, attributes = {}, tag = 'input') {
        return h('label', { key: name }, label, h(tag, {
          ...attributes,
          value: draft[name],
          onChange: event => setField(name, event.target.value),
        }))
      }
      const command = 'node admin.js reconcile --record-id ' + record.recordId +
        ' --execution-id ' + record.executionId + ' --decision ' + decision +
        ' --evidence-file ' + filename + ' --data-dir "$ledgerDir" --dry-run'
      const interactive = 'node admin.js reconcile --record-id ' + record.recordId +
        ' --execution-id ' + record.executionId + ' --data-dir "$ledgerDir" --interactive'
      return h('div', null,
        h('p', null, record.tool + ' · ' + (record.diagnosticCode || record.recordedState)),
        h('p', { className: 'sky-record-id sky-muted' }, '执行代次 ' + record.executionId),
        h('p', { className: 'sky-muted' }, '请先独立核查该笔操作在下游的最终结果。'),
        h('details', null,
          h('summary', null, '在终端直接录入证据'),
          h('p', null, '停止 DSH 和可能仍在执行的下游任务。在可信终端设置 $ledgerDir 后运行以下命令。'),
          h('pre', null, interactive),
          h('p', null, '依次输入核查结论和证据，检查预览后再确认提交。'),
        ),
        h('form', { onSubmit: event => event.preventDefault() },
          h('label', null, '实际核查结论', h('select', {
            value: decision,
            onChange: event => { setDecision(event.target.value); setExported(false) },
          }, h('option', { value: '' }, '请选择'),
          h('option', { value: 'committed' }, '确认已提交'),
          h('option', { value: 'not_committed' }, '确认未提交，且旧请求不会再提交'))),
          field('证据来源', 'source', { maxLength: 120 }),
          field('实际核查时间（本地时间）', 'observedAt', { type: 'datetime-local', step: 1 }),
          field('核查摘要', 'summary', { maxLength: 4096, rows: 2 }, 'textarea'),
          field('证据编号（可选）', 'reference', { maxLength: 120 }),
          draft.observedAt && !validTime && h('p', { role: 'alert' }, '核查时间须在账本最近更新之后且不晚于现在。'),
          !validReference && h('p', { role: 'alert' }, '证据编号仅支持字母、数字、点、下划线和连字符。'),
          h('div', { className: 'sky-actions' }, button('保存证据 JSON', exportEvidence, true, !canExport)),
        ),
        exported && h('div', { role: 'status' },
          h('p', null, '在受信任的终端设置 $ledgerDir，并在证据文件所在目录预览。'),
          h('pre', null, command),
          h('p', null, '核查预览后停止 DSH，把 --dry-run 换成 --expect-preview 令牌 --confirm I_VERIFIED_READBACK。'),
        ),
      )
    }

    function Wizard({ read }) {
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [page, setPage] = useState('setup')
      const [record, setRecord] = useState(null)
      async function refresh(signal) {
        setBusy(true)
        setError('')
        try {
          const result = await read(signal)
          if (!signal?.aborted) {
            setSnapshot(result.ok ? result.value : null)
            if (!result.ok) setError(rpcErrorMessage(result.error?.code))
          }
        } catch (failure) {
          if (!signal?.aborted) {
            setSnapshot(null)
            // The DSH browser carrier throws plain errors for HTTP transport failures.
            const status = /^transport failure for \/api\/skyRecoveryWizard\/snapshot: HTTP (\d{3})$/
              .exec(failure?.message)?.[1]
            const code = status === '404' ? 'gateway/lookup-not-found' :
              ['401', '403'].includes(status) ? 'remote-access/denied' : null
            setError(rpcErrorMessage(code))
          }
        } finally {
          if (!signal?.aborted) setBusy(false)
        }
      }
      useEffect(() => {
        const controller = new AbortController()
        refresh(controller.signal)
        return () => controller.abort()
      }, [read])
      const pending = snapshot?.pending
      const title = record ? '这笔操作的下游结果是什么？' :
        page === 'setup' ? '先检查执行保护' : '有哪些操作需要核查？'
      return h('section', { className: 'sky-web-wizard', 'aria-label': 'SKY Evidence Recovery 向导' },
        h('h2', null, title),
        h('div', { className: 'sky-body' },
          error && h('p', { role: 'alert' }, error),
          busy && h('p', { role: 'status' }, '正在检查插件…'),
          record ? h(Review, { key: record.executionId, record }) :
            page === 'setup' && snapshot ? h(Setup, { snapshot }) :
              page === 'pending' && snapshot && h('div', null,
                !pending ? h('p', null, '账本无法读取，请先检查保护状态。') : h('div', null,
                  h('p', null, pending.total + ' 笔待核查记录。'),
                  !pending.complete && h('p', { role: 'alert' }, pending.unreadable + ' 个账本文件无法读取。'),
                  pending.total > pending.records.length && h('p', null, '显示最近 100 条。完整清单可在操作者 CLI 查看。'),
                  h('ul', { className: 'sky-list' }, pending.records.map(item => h('li', { key: item.recordId },
                    button(item.tool + ' · ' + item.recordId.slice(0, 8) + ' · ' +
                      (item.diagnosticCode || item.recordedState), () => setRecord(item)),
                  ))),
                ),
              ),
        ),
        h('div', { className: 'sky-actions' },
          ...(record ? [button('返回待核查列表', () => setRecord(null))] : [
            button('检查保护状态', () => setPage('setup'), page === 'setup'),
            button('查看待核查记录', () => setPage('pending'), page === 'pending'),
            button('刷新', () => refresh(), false, busy),
          ]),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = css
        document.head.append(style)
        return () => style.remove()
      })
      const read = signal => ctx.connection.rpc.call('/api', 'skyRecoveryWizard/snapshot', { args: {} }, signal)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'sky-evidence-recovery',
        order: 27,
        label: 'SKY Evidence Recovery',
      }, () => h(Wizard, { read })))
    }

    return { inject: ['slots', 'connection'], apply }
  },
})
