#!/usr/bin/env python3
"""Build the app shell from the public UI template."""
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root / 'Design/app-template.html').read_text()
source = re.sub(r'<script>.*?</script>', '', source, flags=re.S)
# Real startup must never display sample conversations if JavaScript fails.
source = re.sub(r'(<nav\b[^>]*id="cmsg-navigation"[^>]*>).*?(<div class="nav-bottom">)',
                r'\1<div class="nav-label">项目</div><div class="empty-state">正在读取远端会话…</div>\2', source, flags=re.S)
source = re.sub(r'(<div class="transcript" id="cmsg-transcript">).*?(</div>\s*<div class="compose-wrap">)',
                r'\1<div class="empty-state">正在启动客户端…</div>\2', source, flags=re.S)
source = re.sub(r'(<div class="chat-heading"><h2>).*?(</h2>)', r'\1新对话\2', source)
source = re.sub(r'(<span class="conversation-name" id="cmsg-contact">).*?(</span>)', r'\1正在连接…\2', source)
source = re.sub(r'(<span class="conversation-meta" id="cmsg-contact-meta"[^>]*>).*?(</span>)', r'\1账号与消息保存在远端\2', source)
source = re.sub(r'(<span class="contact-avatar" id="cmsg-avatar">).*?(</span>)', r'\1…\2', source)
source = re.sub(r'<span class="unread">\d+</span>', '<span class="unread" hidden>0</span>', source)
source = source.replace('SSH 已连接', '正在连接…').replace('回复产品协作群…', '回复当前聊天…').replace('example-project / fix-login', '远端工作区')
css = '''
<style>
html,body{margin:0;padding:0;background:transparent}
#codex-message-concept .app{border:0;border-radius:0;box-shadow:none;min-height:100vh}
#codex-message-concept #cmsg-input,#codex-message-concept #cmsg-reply,#codex-message-concept #cmsg-input:focus,#codex-message-concept #cmsg-reply:focus,#codex-message-concept #cmsg-input:focus-visible,#codex-message-concept #cmsg-reply:focus-visible{outline:none;box-shadow:none}
#codex-message-concept .file-reference{display:inline-flex;align-items:baseline;gap:4px;max-width:100%;padding:0 5px;border-radius:5px;background:var(--app-soft);color:inherit;font:inherit;font-size:.94em;line-height:1.5;vertical-align:baseline;overflow-wrap:anywhere;cursor:pointer}
#codex-message-concept .file-reference:hover{background:var(--app-hover);text-decoration:underline;text-underline-offset:2px}
#codex-message-concept .file-reference .icon{width:12px;height:12px;flex:0 0 auto;align-self:center;color:var(--app-muted)}
#codex-message-concept .file-reference-line{color:var(--app-muted);font-size:.9em}
#codex-message-concept .chrome{position:sticky;top:0;z-index:5;-webkit-user-select:none;user-select:none}
#codex-message-concept .traffic{visibility:hidden}
#codex-message-concept .workspace{height:calc(100vh - 49px);min-height:0}
#codex-message-concept .chat,#codex-message-concept .messages,#codex-message-concept .navigation{height:100%;overflow:hidden}
#codex-message-concept .transcript,#codex-message-concept .conversation-feed,#app-thread-list{overflow-y:auto;min-height:0}
#codex-message-concept .chat-header,#codex-message-concept .compose-wrap,#codex-message-concept .platforms,#codex-message-concept .conversation-switcher,#codex-message-concept .reply-wrap{flex-shrink:0}
#app-thread-list{flex:1}
#codex-message-concept .workspace-add{padding:8px 9px;margin:0 0 7px;width:100%;color:var(--app-muted);text-align:left;font-size:11px;border-radius:6px}
#codex-message-concept .workspace-add:hover,#codex-message-concept .workspace-project-heading:hover{background:var(--app-soft)}
#codex-message-concept .workspace-project{margin-bottom:10px}
#codex-message-concept .workspace-project-heading{display:flex;align-items:center;gap:2px;border-radius:6px;padding:3px 0}
#codex-message-concept .workspace-project-heading.current{color:var(--app-text)}
#codex-message-concept .workspace-disclosure{flex-shrink:0;width:20px;padding:4px 0;font-size:15px;color:var(--app-muted)}
#codex-message-concept .workspace-project-open{display:flex;gap:6px;align-items:center;flex:1;min-width:0;text-align:left;padding:5px 0;font-size:11px;font-weight:500}
#codex-message-concept .workspace-project-open span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#codex-message-concept .workspace-thread-row{display:flex;align-items:center;gap:2px;padding-left:8px}
#codex-message-concept .workspace-thread-row .session{display:flex;align-items:center;gap:5px;min-width:0;flex:1;padding-right:3px}
#codex-message-concept .workspace-thread-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
#codex-message-concept .workspace-more{width:23px;flex-shrink:0;border-radius:4px;color:var(--app-muted);font-size:17px;opacity:.55}
#codex-message-concept .workspace-more:hover{background:var(--app-selected);opacity:1}
#codex-message-concept .workspace-empty{padding:7px 12px;font-size:11px;color:var(--app-muted)}
#codex-message-concept .workspace-pin,#codex-message-concept .workspace-running{color:var(--app-muted);font-size:11px}
#codex-message-concept .workspace-load-more,#codex-message-concept .workspace-archive-toggle{display:block;padding:7px 12px;color:var(--app-muted);font-size:10px;text-align:left}
#codex-message-concept .workspace-menu{position:fixed;z-index:50;min-width:185px;max-width:240px;padding:5px;border:1px solid var(--app-line);border-radius:9px;background:var(--app-surface);box-shadow:0 8px 25px #0002}
#codex-message-concept .workspace-menu button{display:block;width:100%;padding:8px 9px;border-radius:5px;text-align:left;font-size:12px}
#codex-message-concept .workspace-menu button:hover{background:var(--app-selected)}
#codex-message-concept .workspace-menu button:disabled{opacity:.4}
#codex-message-concept .workspace-dialog{width:390px;max-width:calc(100vw - 60px);padding:22px;border:1px solid var(--app-line);border-radius:14px;background:var(--app-surface);color:var(--app-text);box-shadow:0 15px 60px #0003}
#codex-message-concept .workspace-dialog::backdrop{background:#0004}
#codex-message-concept .workspace-dialog h3{margin:0 0 16px;font-size:16px;font-weight:550}
#codex-message-concept .workspace-dialog label{display:block;font-size:12px;margin:12px 0 6px;color:var(--app-muted)}
#codex-message-concept .workspace-dialog input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid var(--app-line);border-radius:7px;background:var(--app-soft);color:var(--app-text);font:inherit}
#codex-message-concept .workspace-dialog-note{font-size:12px;line-height:1.7;color:var(--app-muted)}
#codex-message-concept .workspace-dialog-actions{display:flex;justify-content:flex-end;gap:12px;margin-top:18px}
#codex-message-concept .workspace-dialog-error,#codex-message-concept .workspace-feedback{font-size:11px;color:var(--app-muted);overflow-wrap:anywhere;line-height:1.6}
#codex-message-concept .workspace-feedback{padding:7px 10px;max-height:70px;overflow:auto;flex-shrink:0}
#codex-message-concept .icon{display:inline-block;vertical-align:middle;background:currentColor;-webkit-mask-size:contain;-webkit-mask-repeat:no-repeat;-webkit-mask-position:center;mask-size:contain;mask-repeat:no-repeat;mask-position:center}
#codex-message-concept .app-banner{margin:0 20px 8px;padding:9px 12px;border-radius:8px;background:var(--app-soft);font-size:12px;overflow-wrap:anywhere}
#codex-message-concept .app-banner button{margin-left:6px;text-decoration:underline}
#codex-message-concept .run-notice{margin:0 20px 8px;padding:12px 14px;border:1px solid var(--app-line);border-radius:12px;background:var(--app-soft);font-size:12px;flex-shrink:0;overflow-wrap:anywhere}
#codex-message-concept .run-notice-message{line-height:1.6}
#codex-message-concept .run-notice-actions{display:flex;gap:12px;margin-top:8px}
#codex-message-concept .run-error-details{margin-top:8px;color:var(--app-muted);font-size:11px}
#codex-message-concept .run-error-details pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font:inherit;line-height:1.6}
#codex-message-concept .run-activity{display:flex;align-items:center;gap:8px;padding:5px 24px 10px;min-width:0;color:var(--app-muted);font-size:11px;flex-shrink:0}
#codex-message-concept .run-activity[hidden],#codex-message-concept .run-notice[hidden]{display:none}
#codex-message-concept .run-activity-label{white-space:nowrap;flex:0 0 auto}
#codex-message-concept .run-activity-preview{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#codex-message-concept .thinking-dot{width:7px;height:7px;background:currentColor;border-radius:50%;flex:0 0 auto}
#codex-message-concept .run-activity.is-active .thinking-dot{animation:thinking-pulse 1.5s ease-in-out infinite}
@keyframes thinking-pulse{50%{opacity:.25}}
@media(prefers-reduced-motion:reduce){#codex-message-concept .thinking-dot{animation:none!important}}
#codex-message-concept .reasoning-summary{margin:12px 0;color:var(--app-muted);font-size:11px}
#codex-message-concept .reasoning-summary>summary{display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none;min-width:0}
#codex-message-concept .reasoning-summary>summary::-webkit-details-marker{display:none}
#codex-message-concept .reasoning-label{white-space:nowrap;flex:0 0 auto}
#codex-message-concept .reasoning-preview{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#codex-message-concept .reasoning-body{white-space:pre-wrap;line-height:1.7;margin-top:10px}
#codex-message-concept .reasoning-summary:not([open]) .reasoning-body{display:none}
#codex-message-concept .run-model-picker select{width:100%;font:inherit;padding:8px;color:var(--app-text);background:var(--app-soft);border:1px solid var(--app-line);border-radius:7px}
#codex-message-concept .empty-state{padding:48px 20px;text-align:center;color:var(--app-muted);font-size:12px;line-height:1.8}
#codex-message-concept .empty-state h3{font-size:17px;font-weight:500;color:var(--app-text);margin:0 0 8px}
#codex-message-concept .session{display:block;width:100%;border:0;background:transparent;color:var(--app-text);text-align:left}
#codex-message-concept .navigation .session.active{background:var(--app-selected)}
#codex-message-concept .conversation-feed{min-height:230px}
#codex-message-concept .model-select{max-width:180px;background:transparent;border:0;color:var(--app-muted);font:inherit}
#codex-message-concept .fast-toggle{display:inline-flex;align-items:center;gap:4px;border:0;border-radius:6px;background:transparent;color:var(--app-muted);font:inherit;white-space:nowrap;padding:3px 7px;flex:0 0 auto;cursor:pointer}
#codex-message-concept .fast-toggle .icon{width:14px;height:14px}
#codex-message-concept .fast-toggle.enabled{color:#3981f7;background:rgba(57,129,247,.1)}
#codex-message-concept .fast-toggle:disabled{opacity:.45;cursor:default}
#codex-message-concept .assistant-message{margin-bottom:24px;overflow-wrap:anywhere}
#codex-message-concept .assistant-message pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--app-soft);border:1px solid var(--app-line);border-radius:8px;padding:11px;font:11px/1.7 ui-monospace,monospace}
#codex-message-concept .assistant-message code{font-family:ui-monospace,monospace;font-size:11px;background:var(--app-soft);padding:1px 3px;border-radius:3px}
#codex-message-concept .assistant-message pre code{padding:0;background:transparent}
#codex-message-concept .assistant-message h3{font-size:13px;font-weight:500}
#codex-message-concept .assistant-message ul{padding-left:19px}
#codex-message-concept .assistant-message a{color:inherit;text-decoration:underline}
#codex-message-concept .tool-detail{margin:12px 0;font-size:11px;color:var(--app-muted)}
#codex-message-concept .tool-detail pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 ui-monospace,monospace}
#codex-message-concept .tool-detail summary{overflow-wrap:anywhere;cursor:pointer}
#codex-message-concept .code-card{margin:10px 0;border:1px solid var(--app-line);border-radius:12px;background:var(--app-soft);overflow:hidden;min-width:0}
#codex-message-concept .code-header{display:flex;align-items:center;justify-content:space-between;padding:9px 13px;color:var(--app-muted);font-size:11px}
#codex-message-concept .code-copy{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:2px 4px;border-radius:4px}
#codex-message-concept .code-card pre,#codex-message-concept .assistant-message .code-card pre{margin:0;padding:9px 14px 15px;border:0;border-radius:0;background:transparent;white-space:pre;overflow:auto;overflow-wrap:normal;max-height:360px;font:11px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}
#codex-message-concept .code-card pre code{font:inherit;background:transparent;padding:0;white-space:pre;overflow-wrap:normal}
#codex-message-concept .user-message p{margin:0 0 8px}
#codex-message-concept .user-message p:last-child{margin-bottom:0}
#codex-message-concept .user-message .code-card{background:var(--app-surface);text-align:left}
#codex-message-concept .user-message code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
#codex-message-concept .markdown-table-block{margin:12px 0;max-width:100%;min-width:0;text-align:left}
#codex-message-concept .markdown-table-scroll{max-width:100%;overflow-x:auto;border:1px solid var(--app-line);border-radius:9px;overscroll-behavior-x:contain}
#codex-message-concept .markdown-table{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;font:inherit;font-size:12px;line-height:1.65}
#codex-message-concept .markdown-table th,#codex-message-concept .markdown-table td{padding:10px 12px;vertical-align:top;white-space:normal;overflow-wrap:anywhere;border-bottom:1px solid var(--app-line);border-right:1px solid var(--app-line)}
#codex-message-concept .markdown-table th{background:var(--app-soft);font-weight:600}
#codex-message-concept .markdown-table tr:last-child td{border-bottom:0}
#codex-message-concept .markdown-table th:last-child,#codex-message-concept .markdown-table td:last-child{border-right:0}
#codex-message-concept .markdown-table .file-reference{display:inline;white-space:normal;text-align:inherit}
#codex-message-concept .table-more{margin-top:8px}
#codex-message-concept .command-detail{margin:14px 0 20px;min-width:0}
#codex-message-concept .command-detail>summary{list-style:none;display:flex;flex-wrap:nowrap;gap:8px;align-items:center;min-width:0;overflow:hidden;user-select:none}
#codex-message-concept .command-detail>summary::-webkit-details-marker{display:none}
#codex-message-concept .command-title{font-size:12px;flex:0 0 auto;white-space:nowrap;overflow-wrap:normal}
#codex-message-concept .command-preview{font-size:11px;flex:1 1 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#codex-message-concept .command-detail[open] .command-preview{display:none}
#codex-message-concept .command-detail>summary>.icon{flex:0 0 auto}
#codex-message-concept .command-caret{flex:0 0 18px;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;margin-left:auto;transition:transform .12s}
#codex-message-concept .command-detail:not([open]) .command-caret{transform:rotate(-90deg)}
#codex-message-concept .command-running>summary>.icon{animation:command-pulse 1.4s ease-in-out infinite}
#codex-message-concept .command-source{display:block;margin-bottom:14px}
#codex-message-concept .command-result{text-align:right;padding:0 14px 11px;font-size:11px;color:var(--app-muted)}
#codex-message-concept .command-detail[data-status=failed] .command-result{color:#d66}
@keyframes command-pulse{50%{opacity:.35}}
@media(prefers-reduced-motion:reduce){#codex-message-concept .command-running>summary>.icon{animation:none}}
#codex-message-concept .text-more{display:block;margin-top:8px;font:11px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;color:var(--app-muted)}
#codex-message-concept .approval{border:1px solid var(--app-line);padding:14px;margin:12px 0;border-radius:9px;background:var(--app-soft)}
#codex-message-concept .approval pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 ui-monospace,monospace}
#codex-message-concept .approval label{display:block;font-size:12px;margin:8px 0}
#codex-message-concept .approval input{display:block;box-sizing:border-box;width:100%;margin:5px 0;padding:7px;border:1px solid var(--app-line);border-radius:6px;background:var(--app-surface);color:var(--app-text)}
#codex-message-concept .approval-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
#codex-message-concept button:disabled{opacity:.45}
#codex-message-concept .source-label{overflow-wrap:anywhere}
#codex-message-concept .demo-label{font-size:10px;color:var(--app-muted);margin-left:8px}
#codex-message-concept .attachment-action{position:relative;display:flex;align-items:center}
#codex-message-concept .attachment-menu{position:absolute;bottom:36px;left:0;z-index:9;min-width:160px;padding:5px;background:var(--app-surface);border:1px solid var(--app-line);border-radius:10px;box-shadow:0 6px 24px #0002}
#codex-message-concept .attachment-menu button{display:flex;align-items:center;gap:9px;width:100%;padding:9px;border-radius:6px;font:12px -apple-system,BlinkMacSystemFont,sans-serif;text-align:left;color:var(--app-text)}
#codex-message-concept .attachment-menu button:hover{background:var(--app-soft)}
#codex-message-concept .attachment-list{display:flex;flex-wrap:wrap;gap:8px;padding:5px 2px 10px;max-height:164px;overflow-y:auto}
#codex-message-concept .attachment-card{display:flex;position:relative;max-width:216px;min-width:146px;border:1px solid var(--app-line);border-radius:10px;background:var(--app-surface);overflow:hidden;text-align:left}
#codex-message-concept .attachment-preview{display:flex;align-items:center;gap:9px;min-width:0;padding:9px 24px 9px 9px;color:var(--app-text);text-align:left;flex:1}
#codex-message-concept .attachment-thumb{width:46px;height:46px;object-fit:contain;border-radius:5px;background:var(--app-soft)}
#codex-message-concept .attachment-copy{display:flex;flex-direction:column;gap:5px;min-width:0}
#codex-message-concept .attachment-name{display:block;font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#codex-message-concept .attachment-meta{font-size:10px;color:var(--app-muted);overflow-wrap:anywhere}
#codex-message-concept .attachment-remove{position:absolute;right:3px;top:3px;display:flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:50%;color:var(--app-muted)}
#codex-message-concept .attachment-remove .icon{width:12px;height:12px}
#codex-message-concept .attachment-remove:hover{background:var(--app-soft)}
#codex-message-concept .attachment-status{padding:0 3px 8px;font-size:11px;color:var(--app-muted)}
#codex-message-concept .attachment-card[data-status=error]{border-color:#c77}
#codex-message-concept .composer.is-file-drag{outline:2px solid var(--app-text);outline-offset:3px;background:var(--app-soft)}
#codex-message-concept .sent-attachments{margin-top:8px;max-height:none;padding-bottom:0}
#codex-message-concept .composer{position:relative}
#codex-message-concept .project-file-picker{position:absolute;bottom:calc(100% + 8px);left:0;right:0;max-height:290px;overflow-y:auto;background:var(--app-surface);border:1px solid var(--app-line);border-radius:10px;padding:5px;box-shadow:0 6px 24px #0002;z-index:10}
#codex-message-concept .project-picker-note{padding:7px 9px;font-size:11px;color:var(--app-muted)}
#codex-message-concept .project-file-option{display:flex;align-items:center;gap:8px;width:100%;padding:8px 9px;text-align:left;font:12px -apple-system,BlinkMacSystemFont,sans-serif;color:var(--app-text);border-radius:6px}
#codex-message-concept .project-file-option span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#codex-message-concept .project-file-option:hover,#codex-message-concept .project-file-option[aria-selected=true]{background:var(--app-soft)}
#codex-message-concept .command-entry{font:16px -apple-system,BlinkMacSystemFont,sans-serif;color:var(--app-muted);width:25px;height:27px;border-radius:5px}
#codex-message-concept .command-entry:hover{background:var(--app-soft)}
#codex-message-concept .command-palette{position:absolute;bottom:calc(100% + 8px);left:0;right:0;max-height:310px;overflow:auto;padding:5px;background:var(--app-surface);border:1px solid var(--app-line);border-radius:11px;box-shadow:0 8px 28px #0002;z-index:12}
#codex-message-concept .command-option{display:flex;align-items:center;justify-content:space-between;gap:15px;width:100%;text-align:left;border-radius:7px;padding:10px 12px;color:var(--app-text)}
#codex-message-concept .command-option[aria-selected=true],#codex-message-concept .command-option:hover{background:var(--app-soft)}
#codex-message-concept .command-option span{display:flex;flex-direction:column;gap:4px}
#codex-message-concept .command-option strong{font-size:12px;font-weight:500}
#codex-message-concept .command-option small,#codex-message-concept .command-option code{font-size:11px;color:var(--app-muted)}
#codex-message-concept .plan-mode-button{display:flex;align-items:center;gap:5px;border:1px solid var(--app-line);border-radius:6px;padding:4px 7px;font-size:11px;color:var(--app-text)}
#codex-message-concept .plan-mode-button .icon{width:12px;height:12px}
#codex-message-concept .command-note{font-size:11px;color:var(--app-muted);padding:0 3px 8px}
#codex-message-concept .thread-work{display:flex;flex-direction:column;gap:7px;margin-bottom:9px}
#codex-message-concept .goal-card,#codex-message-concept .plan-progress{border:1px solid var(--app-line);border-radius:10px;background:var(--app-surface);padding:10px 12px;font-size:12px}
#codex-message-concept .work-heading,#codex-message-concept .plan-progress summary{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--app-muted)}
#codex-message-concept .work-heading strong{font-weight:500;color:var(--app-text)}
#codex-message-concept .work-heading .icon,#codex-message-concept .plan-progress summary .icon{width:14px;height:14px}
#codex-message-concept .work-state{margin-left:auto;font-size:10px;color:var(--app-muted)}
#codex-message-concept .goal-summary{margin:8px 0;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
#codex-message-concept .work-footer{display:flex;align-items:center;gap:10px;justify-content:space-between}
#codex-message-concept .goal-usage{font-size:10px;color:var(--app-muted)}
#codex-message-concept .work-actions{display:flex;gap:7px}
#codex-message-concept .work-action{font-size:11px;color:var(--app-muted);padding:3px;border-radius:4px}
#codex-message-concept .work-action:hover{background:var(--app-soft);color:var(--app-text)}
#codex-message-concept .plan-progress summary{cursor:pointer;list-style:none}
#codex-message-concept .plan-progress summary::-webkit-details-marker{display:none}
#codex-message-concept .plan-progress ol{list-style:none;margin:10px 0 0;padding:0;max-height:190px;overflow:auto}
#codex-message-concept .plan-progress li{display:flex;gap:8px;padding:5px 0;line-height:1.5;overflow-wrap:anywhere}
#codex-message-concept .plan-progress li[data-status=completed]{color:var(--app-muted)}
#codex-message-concept .plan-progress li[data-status=inProgress]{font-weight:500}
#codex-message-concept .plan-sync-note{font-size:11px;color:var(--app-muted);padding:2px 12px}
#codex-message-concept .step-state{width:14px;flex-shrink:0}
#codex-message-concept .plan-explanation{font-size:11px;color:var(--app-muted);margin:10px 0 0}
#codex-message-concept .proposed-plan{border:1px solid var(--app-line);border-radius:12px;padding:16px}
#codex-message-concept .proposed-plan .implement-plan{margin-top:12px}
#codex-message-concept .goal-editor{width:min(460px,calc(100vw - 90px));color:var(--app-text);background:var(--app-surface);border:1px solid var(--app-line);border-radius:15px;padding:24px;box-shadow:0 16px 60px #0005}
#codex-message-concept .goal-editor::backdrop{background:#0006}
#codex-message-concept .goal-editor h3{font-size:17px;font-weight:600;margin:0 0 10px}
#codex-message-concept .goal-editor-description{font-size:12px;line-height:1.6;color:var(--app-muted);margin-bottom:18px}
#codex-message-concept .goal-editor label{display:block;font-size:12px;margin:12px 0 7px}
#codex-message-concept .goal-editor textarea,#codex-message-concept .goal-editor input{display:block;box-sizing:border-box;width:100%;border:1px solid var(--app-line);border-radius:8px;padding:10px;font:12px -apple-system,BlinkMacSystemFont,sans-serif;background:var(--app-soft);color:var(--app-text);line-height:1.6}
#codex-message-concept .goal-editor textarea{resize:vertical;min-height:100px;max-height:35vh}
#codex-message-concept .goal-editor-error{font-size:11px;color:#c77;margin-top:10px}
#codex-message-concept .goal-editor-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}

#codex-message-concept .effort-select{max-width:115px;margin-left:7px;font-size:11px}
#codex-message-concept .settings-note{font-size:10px;color:var(--app-muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#codex-message-concept .remote-account-dialog{width:min(490px,calc(100vw - 72px));max-height:calc(100vh - 72px);box-sizing:border-box;overflow:auto}
#codex-message-concept .remote-account-dialog p{font-size:12px;line-height:1.5;margin:10px 0;color:var(--app-muted)}
#codex-message-concept .remote-account-dialog .workspace-dialog-actions{position:sticky;bottom:-24px;background:var(--app-surface);padding:12px 0 4px;flex-wrap:wrap}
#codex-message-concept .remote-account-summary{background:var(--app-soft);border-radius:9px;padding:12px;font-size:14px;overflow-wrap:anywhere}
#codex-message-concept .remote-account-code{margin-top:16px;padding:16px;border:1px solid var(--app-line);border-radius:10px}
#codex-message-concept #remote-account-code{display:block;font:600 25px ui-monospace,monospace;letter-spacing:3px;user-select:text}
#codex-message-concept .remote-account-actions{display:flex;flex-wrap:wrap;gap:8px}
#codex-message-concept .remote-account-status{min-height:20px;overflow-wrap:anywhere}
#codex-message-concept .subagent-panel{margin:0 20px 8px;flex-shrink:0;font-size:12px}
#codex-message-concept .subagent-readonly{color:var(--app-muted);font-size:11px;margin-left:12px}
#codex-message-concept .subagents{border:1px solid var(--app-line);border-radius:9px;background:var(--app-surface)}
#codex-message-concept .subagents summary{cursor:pointer;padding:10px 12px;color:var(--app-muted);font-size:11px}
#codex-message-concept .subagent-list{max-height:min(34vh,280px);overflow:auto;padding:0 5px 5px}
#codex-message-concept .subagent-row{display:block;width:100%;padding:9px;border-radius:7px;text-align:left;color:var(--app-text)}
#codex-message-concept .subagent-row:hover{background:var(--app-soft)}
#codex-message-concept .subagent-title{display:flex;align-items:center;gap:8px}
#codex-message-concept .subagent-title strong{font-size:12px;font-weight:500}
#codex-message-concept .subagent-role,#codex-message-concept .subagent-preview{font-size:11px;color:var(--app-muted);margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#codex-message-concept .question-badge{font-size:10px;border:1px solid var(--app-line);border-radius:5px;padding:2px 5px}
#codex-message-concept .question-alerts{flex-shrink:0;margin:0 20px 8px;max-height:120px;overflow:auto;border:1px solid var(--app-line);border-radius:9px;background:var(--app-soft)}
#codex-message-concept .question-alert{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;font-size:12px;text-align:left}
#codex-message-concept .question-alert:hover{background:var(--app-line)}
#codex-message-concept .question-alert>span:first-of-type{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#codex-message-concept .question-alert-open{margin-left:auto;flex-shrink:0;color:var(--app-muted)}
#codex-message-concept .question-notification-hint{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;font-size:11px;color:var(--app-muted)}
#codex-message-concept .question-highlight{outline:2px solid var(--app-muted);outline-offset:-2px}
#codex-message-concept .question-field{border:0;padding:0;margin:14px 0;min-width:0}
#codex-message-concept .question-field legend{font-size:11px;color:var(--app-muted)}
#codex-message-concept .question-field p{font-size:12px;line-height:1.6;margin:5px 0 9px}
#codex-message-concept .approval .question-option{display:grid;grid-template-columns:18px 1fr;gap:3px 7px;border:1px solid var(--app-line);border-radius:7px;padding:9px;cursor:pointer}
#codex-message-concept .question-option:has(input:checked){border-color:var(--app-muted);background:var(--app-surface)}
#codex-message-concept .approval .question-option input{display:inline;width:auto;margin:0;accent-color:var(--app-text)}
#codex-message-concept .question-option small{grid-column:2;color:var(--app-muted);font-size:11px;line-height:1.5}
#codex-message-concept .question-text{display:block;box-sizing:border-box;width:100%;font:12px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;padding:9px;margin:8px 0;border:1px solid var(--app-line);border-radius:7px;background:var(--app-surface);color:var(--app-text);resize:vertical}
#codex-message-concept .question-error{font-size:11px;color:#c77}
#codex-message-concept .async-question{border:1px solid var(--app-line);border-radius:9px;padding:12px;margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
#codex-message-concept .async-question strong{width:100%;font-size:12px;font-weight:500}

#codex-message-concept .subagent-filters{display:flex;gap:7px;padding:0 10px 8px;font-size:10px;color:var(--app-muted)}
#codex-message-concept .subagent-filter{padding:4px 7px;border-radius:5px;color:inherit}
#codex-message-concept .subagent-filter[aria-pressed=true]{background:var(--app-soft);color:var(--app-text)}
#codex-message-concept .subagent-entry{border-radius:7px}
#codex-message-concept .subagent-entry[data-expanded=true]{background:var(--app-soft)}
#codex-message-concept .subagent-caret{font-size:10px;width:9px;color:var(--app-muted)}
#codex-message-concept .subagent-row .subagent-preview{padding-left:17px;margin-top:5px;font-size:11px;line-height:1.5}
#codex-message-concept .subagent-inline{padding:0 10px 10px 25px}
#codex-message-concept .subagent-message-heading{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;font-size:10px;color:var(--app-muted);margin:3px 0 7px}
#codex-message-concept .subagent-task{font-size:10px;line-height:1.6;color:var(--app-muted);margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:58px;overflow:auto}
#codex-message-concept .subagent-feed{max-height:160px;min-height:65px;overflow:auto;border-left:1px solid var(--app-line);padding:0 10px 0 12px;font-size:12px;line-height:1.65;overflow-anchor:none}
#codex-message-concept .subagent-message{padding:7px 0;overflow-wrap:anywhere}
#codex-message-concept .subagent-message p{margin:3px 0 8px}
#codex-message-concept .subagent-author{font-size:10px;color:var(--app-muted);margin-bottom:4px}
#codex-message-concept .subagent-message pre{white-space:pre-wrap;background:var(--app-surface);padding:8px;border-radius:5px;font:11px/1.6 ui-monospace,monospace}
#codex-message-concept .subagent-tool,#codex-message-concept .subagent-empty{font-size:11px;color:var(--app-muted)}
#codex-message-concept .subagent-latest{font-size:10px;padding:5px 9px;border:1px solid var(--app-line);border-radius:7px;margin-top:7px;color:var(--app-text);background:var(--app-surface)}
#codex-message-concept .message-media{margin:9px 0;padding:10px;border:1px solid var(--app-line);border-radius:9px;max-width:100%;overflow:hidden}
#codex-message-concept .message-media-name{font-size:12px;overflow-wrap:anywhere}
#codex-message-concept .message-media-meta,#codex-message-concept .message-media-legacy{font-size:10px;line-height:1.6;color:var(--app-muted);margin:4px 0}
#codex-message-concept .message-media-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px}
#codex-message-concept .message-media-action{font-size:10px;color:var(--app-muted);text-align:left}
#codex-message-concept .message-media-action:hover{color:var(--app-text);text-decoration:underline}
#codex-message-concept .message-media-action:disabled{opacity:.4}
#codex-message-concept .message-media-image{max-width:100%;max-height:230px;object-fit:contain;border-radius:6px;margin-top:8px;cursor:zoom-in}
#codex-message-concept .message-media-view video{width:100%;max-height:230px;margin-top:8px;border-radius:6px}
#codex-message-concept .message-media-view audio{width:100%;margin-top:8px;height:38px}
#codex-message-concept .message-draft-file{display:flex;justify-content:space-between;gap:8px;padding:8px;font-size:10px;overflow-wrap:anywhere}
#codex-message-concept .message-add{display:inline-flex;align-items:center;padding:3px 5px;color:var(--app-muted)}
#codex-message-concept .message-add:disabled{opacity:.35}
#codex-message-concept .message-account-status{font-size:11px;line-height:1.6;padding:8px 14px;color:var(--app-muted);background:var(--app-soft);flex-shrink:0}
#codex-message-concept .whatsapp-link-open{flex-shrink:0;padding:7px 14px;font-size:10px;color:var(--app-muted);text-align:left}
#codex-message-concept .whatsapp-link-tabs{display:flex;gap:10px;margin:14px 0}
#codex-message-concept .whatsapp-link-tabs button{font-size:12px;padding:7px 10px;border-radius:6px;background:var(--app-soft)}
#codex-message-concept .whatsapp-link-tabs button[aria-selected=true]{background:var(--app-selected);color:var(--app-text)}
#codex-message-concept .whatsapp-link-status{font-size:12px;margin:15px 0;color:var(--app-muted)}
#codex-message-concept .whatsapp-link-result{text-align:center;font-size:12px;line-height:1.7}
#codex-message-concept .whatsapp-link-qr{display:block;width:256px;height:256px;max-width:100%;margin:12px auto;background:#fff;padding:8px;box-sizing:border-box}
#codex-message-concept .whatsapp-pairing-code{font:32px/1.5 ui-monospace,monospace;letter-spacing:4px;margin:18px 0;user-select:text}
#codex-message-concept .message-mention{display:inline;padding:1px 5px;border-radius:4px;background:var(--app-soft);color:var(--app-text);font-weight:500;box-decoration-break:clone;-webkit-box-decoration-break:clone}
#codex-message-concept .workspace-splitter{grid-column:3;grid-row:1;justify-self:start;align-self:stretch;width:9px;margin-left:-4px;z-index:4;position:relative;cursor:col-resize;touch-action:none;user-select:none;-webkit-user-select:none}
#codex-message-concept .workspace-splitter::after{content:"";position:absolute;top:0;bottom:0;left:4px;width:1px;background:transparent;transition:background .12s,width .12s}
#codex-message-concept .workspace-splitter:hover::after,#codex-message-concept .workspace-splitter:focus-visible::after,#codex-message-concept.is-resizing-panels .workspace-splitter::after{left:3px;width:3px;background:var(--app-muted)}
#codex-message-concept .workspace-splitter:focus-visible{outline:none}
#codex-message-concept.is-resizing-panels,#codex-message-concept.is-resizing-panels *{cursor:col-resize!important;user-select:none!important;-webkit-user-select:none!important}
#codex-message-concept .usage-dialog{width:510px;max-height:calc(100vh - 70px);overflow-y:auto}
#codex-message-concept .usage-dialog[open]{display:flex;flex-direction:column;overflow:hidden}
#codex-message-concept .usage-content{overflow-y:auto;min-height:0;flex:1 1 auto}
#codex-message-concept .usage-dialog>h3,#codex-message-concept .usage-dialog>.usage-context,#codex-message-concept .usage-dialog>.usage-status,#codex-message-concept .usage-dialog>.workspace-dialog-actions{flex-shrink:0}
#codex-message-concept .usage-context,#codex-message-concept .usage-status,#codex-message-concept .usage-updated{font-size:11px;line-height:1.6;color:var(--app-muted)}
#codex-message-concept .usage-section{margin:18px 0;padding-top:14px;border-top:1px solid var(--app-line)}
#codex-message-concept .usage-section h4{font-size:12px;margin:0 0 10px;font-weight:600}
#codex-message-concept .usage-metric{display:flex;justify-content:space-between;align-items:baseline;gap:14px;font-size:12px;line-height:1.7;margin:5px 0}
#codex-message-concept .usage-metric>span{color:var(--app-muted)}
#codex-message-concept .usage-metric strong{font-weight:500;text-align:right}
#codex-message-concept .usage-limit-name{font-size:11px;color:var(--app-muted);margin:6px 0}
#codex-message-concept .usage-window,#codex-message-concept .usage-thread-group{margin:8px 0 15px}
#codex-message-concept .usage-progress{display:block;appearance:none;-webkit-appearance:none;width:100%;height:5px;border:0;border-radius:4px;overflow:hidden;background:var(--app-soft);accent-color:var(--app-text)}
#codex-message-concept .usage-progress::-webkit-progress-bar{background:var(--app-soft)}
#codex-message-concept .usage-progress::-webkit-progress-value{background:var(--app-muted);border-radius:4px}
#codex-message-concept .usage-reset,#codex-message-concept .usage-muted{font-size:10px;line-height:1.6;color:var(--app-muted);margin:6px 0}
#codex-message-concept .send-control{position:relative;display:inline-flex;margin-left:auto;flex:0 0 auto}
#codex-message-concept .send-control .send{margin-left:0}
#codex-message-concept .send-help{position:absolute;inset:-2px;z-index:1;border:0;border-radius:50%;padding:0;background:transparent;cursor:help}
#codex-message-concept .send-help:hover{background:transparent}
#codex-message-concept{--font-scale:1.3333333333}
#codex-message-concept #cmsg-input,#codex-message-concept #cmsg-reply{font-size:12px}
#codex-message-concept .conversation-picker{display:flex;flex-direction:column;max-height:calc(100vh - 260px);overflow:hidden}
#codex-message-concept #cmsg-conversation-options{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;overflow-anchor:none}
#codex-message-concept .option-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#codex-message-concept .option-tail{flex:0 0 auto;min-width:44px;min-height:calc(32px * var(--font-scale));display:flex;flex-direction:column;align-items:flex-end;gap:5px}
#codex-message-concept .option-time{font-size:9px;color:var(--app-muted);white-space:nowrap}
#codex-message-concept .conversation-unread{min-width:1.7em;height:1.7em;padding:0 5px;border-radius:1em;display:grid;place-items:center;background:var(--app-wa);color:var(--app-on-strong);font-size:10px;font-weight:600}
#codex-message-concept .unread{min-width:1.6em;height:1.6em}
#codex-message-concept .has-unread .option-name{font-weight:650}
#codex-message-concept .option-check{flex:0 0 auto}
#codex-message-concept .platform .unread{margin-left:4px}
#codex-message-concept .font-settings{width:100%;cursor:pointer;border-radius:7px}
#codex-message-concept .font-setting-glyph{width:15px;font-size:11px;font-weight:600;flex:0 0 auto}
#codex-message-concept .font-dialog p{color:var(--app-muted);line-height:1.6}
#codex-message-concept .font-size-controls{display:flex;align-items:center;justify-content:center;gap:15px;margin:18px 0}
#codex-message-concept .font-size-controls button{min-width:36px;min-height:32px;font-size:18px}
#codex-message-concept .font-size-controls select{padding:8px 12px;background:var(--app-soft);color:var(--app-text);font:inherit;border:1px solid var(--app-line);border-radius:8px}
#codex-message-concept .font-size-sample{white-space:pre-wrap;padding:15px;background:var(--app-soft);border-radius:9px;font-size:12px;line-height:1.7;overflow-wrap:anywhere}
#codex-message-concept .async-question{padding:16px;margin:12px 0;border:1px solid var(--app-line);border-radius:12px;display:flex;flex-direction:column;gap:12px}
#codex-message-concept .async-question-options{display:flex;flex-direction:column;gap:8px}
#codex-message-concept .async-question .question-option{cursor:pointer}
#codex-message-concept .async-question>button{align-self:flex-start}
#codex-message-concept .async-question-status,#codex-message-concept .question-reply-label{color:var(--app-muted);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}
#codex-message-concept .question-reply-title{color:var(--app-muted);white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:8px}
#codex-message-concept .question-reply-answer{white-space:pre-wrap;overflow-wrap:anywhere}
#codex-message-concept .question-reply-history>section+section{margin-top:18px}
#codex-message-concept .viewed-images{margin:12px 0;color:var(--app-muted)}
#codex-message-concept .viewed-images>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;font-size:12px;line-height:1.7}
#codex-message-concept .viewed-images>summary::-webkit-details-marker{display:none}
#codex-message-concept .viewed-images>summary:after{content:'⌄';font-size:13px;margin-left:2px;transform:rotate(-90deg)}
#codex-message-concept .viewed-images[open]>summary:after{transform:none}
#codex-message-concept .viewed-image-content{display:flex;align-items:flex-start;gap:10px;margin:10px 0 0 0}
#codex-message-concept .viewed-image-thumb{width:112px;height:112px;flex:0 0 112px;padding:3px;overflow:hidden;border-radius:12px;border:1px solid var(--app-line);background:var(--app-soft);color:var(--app-muted);cursor:zoom-in;display:flex;align-items:center;justify-content:center;white-space:pre-wrap;font:inherit;font-size:10px}
#codex-message-concept .viewed-image-thumb img{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}
#codex-message-concept .viewed-image-status{font-size:10px;line-height:1.6;overflow-wrap:anywhere;max-width:360px}
</style>
'''
def scaled_fonts(value):
    value = re.sub(r'(font-size\s*:\s*)(\d+(?:\.\d+)?)px', r'\1calc(\2px * var(--font-scale, 1))', value)
    return re.sub(r'(font\s*:\s*)(\d+(?:\.\d+)?)px', r'\1calc(\2px * var(--font-scale, 1))', value)

source, css = scaled_fonts(source), scaled_fonts(css)
head = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: remote-codex-media:; media-src remote-codex-media:; connect-src \'none\'; object-src \'none\'; frame-src \'none\'; base-uri \'none\'"></head><body>'
destination = root / 'Sources/RemoteCodex/Resources/index.html'
scripts = ['transcript', 'subagents', 'session', 'usage', 'commands', 'drafts', 'projects', 'message-media', 'whatsapp-link', 'message-format', 'split-layout', 'appearance', 'inbox', 'async-questions', 'viewed-images', 'remote-account', 'run-state', 'app']
destination.write_text(head + source + css + ''.join(f'<script src="{name}.js"></script>' for name in scripts) + '</body></html>')
print(destination)
