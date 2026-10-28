"""HTTP 请求与响应模型。字段用 camelCase，与 Agent 报告一致。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from mewcode_api.settings import MAX_TIMEOUT_MS

RunStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


class CreateRunBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=200_000)
    workspace: str | None = None
    sessionId: str | None = None
    timeoutMs: int | None = Field(default=None, ge=1_000, le=MAX_TIMEOUT_MS)

    @field_validator("prompt")
    @classmethod
    def strip_prompt(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("prompt 为空")
        return text


class CreateRunResponse(BaseModel):
    runId: str
    sessionId: str | None = None
    status: RunStatus
    workspace: str
    position: int = 1


class CreateConversationBody(BaseModel):
    workspace: str | None = None


class ConversationSummary(BaseModel):
    sessionId: str
    workspace: str
    label: str
    busy: bool = False
    createdAt: str
    updatedAt: str


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    createdAt: str


class ConversationDetail(ConversationSummary):
    messages: list[ConversationMessage] = Field(default_factory=list)


class SendMessageBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=200_000)
    workspace: str | None = None

    @field_validator("prompt")
    @classmethod
    def strip_prompt(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("prompt 为空")
        return text


class SendMessageResponse(BaseModel):
    sessionId: str
    runId: str
    status: RunStatus
    workspace: str
    position: int = 1


class ApprovalBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    approvalId: str = Field(min_length=1)
    choice: Literal["deny", "once", "session", "permanent"]


class RunView(BaseModel):
    runId: str
    status: RunStatus
    workspace: str
    sessionId: str | None = None
    partialText: str = ""
    error: str | None = None
    report: dict[str, Any] | None = None
    cancelRequested: bool = False
    createdAt: str
    startedAt: str | None = None
    endedAt: str | None = None


class StepView(BaseModel):
    seq: int
    kind: Literal["thinking", "tool", "text"]
    text: str | None = None
    tool: str | None = None
    subject: str | None = None
    ok: bool | None = None
    summary: str | None = None
    approval: dict[str, Any] | None = None
    warnings: list[str] | None = None
