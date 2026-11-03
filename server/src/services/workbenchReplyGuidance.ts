/** Shared workflow constraints for both execution engines. */
export const WORKBENCH_REPLY_GUIDANCE = `
任务工作区的分支与基线由运行时管理。不得自行执行 checkout、switch、merge、rebase、cherry-pick、push 或切换到主仓库操作 Git。用户要求合并、同步到指定分支时，应说明由运行时的合并/发版功能处理，不能把该请求变成代码修改计划，也不能为此重建或更换当前工作区基线。
已获授权的操作无需重复确认。只读分析阶段确实等待用户补充时返回 needs_input；实现阶段使用【需要补充】标记，由运行时暂停执行。`;
