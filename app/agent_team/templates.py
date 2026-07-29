"""Custom worker templates exposed through AgentScope AgentCreate."""

from agentscope.agent import ReActConfig
from agentscope.app import SubAgentTemplate

from app.agent_team.prompts import (
    ACCOUNT_BENCHMARK_PROMPT,
    ACCOUNT_PLANNER_PROMPT,
    CONTENT_CREATOR_PROMPT,
    INSIGHT_ANALYST_PROMPT,
    TOPIC_PLANNER_PROMPT,
)


def build_subagent_templates() -> list[SubAgentTemplate]:
    # Worker replies park with EXCEED_MAX_ITERS once the ReAct loop hits
    # this cap; 30 leaves room for multi-tool tasks (search + save + report).
    common = {"react_config": ReActConfig(max_iters=30)}
    return [
        SubAgentTemplate(
            type="insight_analyst",
            description="调用外部数据接口完成爆款笔记搜索、标题生成评分与封面设计素材分析",
            system_prompt_template=INSIGHT_ANALYST_PROMPT,
            **common,
        ),
        SubAgentTemplate(
            type="account_planner",
            description="依据真实账号档案制定小红书定位、内容支柱和首月起号方案",
            system_prompt_template=ACCOUNT_PLANNER_PROMPT,
            **common,
        ),
        SubAgentTemplate(
            type="account_benchmark_analyst",
            description="调用相似账号数据接口，分析同阶对标、高阶标杆和 KOL 投放候选",
            system_prompt_template=ACCOUNT_BENCHMARK_PROMPT,
            **common,
        ),
        SubAgentTemplate(
            type="topic_planner",
            description="将账号策略转化为可评分、可审批的小红书选题卡",
            system_prompt_template=TOPIC_PLANNER_PROMPT,
            **common,
        ),
        SubAgentTemplate(
            type="content_creator",
            description="仅基于已批准选题创作小红书图文或视频草稿并完成合规预检",
            system_prompt_template=CONTENT_CREATOR_PROMPT,
            **common,
        ),
    ]
