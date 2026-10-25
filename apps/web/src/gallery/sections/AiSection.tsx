import {
  ApprovalCard,
  AuthorGroup,
  Avatar,
  DaySeparator,
  Fence,
  IconCopy,
  IconUndo,
  Markdown,
  Message,
  MessageAction,
  MessageActions,
  MessageBranch,
  Reasoning,
  RunStatusChip,
  ToolCard,
} from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { CHAT, RUN_STATUSES, SAMPLE, TOOL_DETAILS } from "../fixtures.ts";
import { GalleryItem, GallerySection } from "../GalleryItem.tsx";
import { ExtensionFigures } from "./ExtensionFigures.tsx";

function Messages() {
  const [branch, setBranch] = useState(1);
  const actions = (
    <MessageActions label={CHAT.author.agent}>
      <MessageAction label={CHAT.copy} icon={IconCopy} />
      <MessageAction label={CHAT.retry} icon={IconUndo} />
    </MessageActions>
  );
  return (
    <>
      <GalleryItem name="Message" column>
        <Message author="you" label={CHAT.author.you} meta={CHAT.meta}>
          {CHAT.you}
        </Message>
        <Message author="agent" label={CHAT.author.agent} meta={CHAT.meta} actions={actions}>
          {CHAT.agent}
        </Message>
        <Message author="tool" label={CHAT.author.tool}>
          {CHAT.tool}
        </Message>
        <Message author="agent" label={CHAT.author.agent} actions={actions}>
          <Markdown text={CHAT.markdown} />
        </Message>
      </GalleryItem>
      <GalleryItem name="MessageActions">{actions}</GalleryItem>
      <GalleryItem name="MessageAction">
        <MessageAction label={CHAT.copy} icon={IconCopy} />
      </GalleryItem>
      <GalleryItem name="MessageBranch">
        <MessageBranch
          index={branch}
          count={3}
          groupLabel={CHAT.branchGroup}
          previousLabel={CHAT.previous}
          nextLabel={CHAT.next}
          position={`${branch + 1} / 3`}
          onChange={setBranch}
        />
      </GalleryItem>
      <GalleryItem name="AuthorGroup" column>
        <AuthorGroup
          author="agent"
          name={CHAT.author.agent}
          meta={CHAT.meta}
          avatar={<Avatar initials="AG" name={SAMPLE.agentName} presence="running" />}
        >
          <Message author="agent" label={CHAT.author.agent} grouped>
            {CHAT.agent}
          </Message>
        </AuthorGroup>
      </GalleryItem>
      <GalleryItem name="DaySeparator" column>
        <DaySeparator label={CHAT.day} />
      </GalleryItem>
      <GalleryItem name="Markdown" column>
        <Markdown text={CHAT.markdown} />
      </GalleryItem>
    </>
  );
}

function Runs() {
  return (
    <>
      <GalleryItem name="RunStatusChip">
        {RUN_STATUSES.map((status) => (
          <RunStatusChip key={status} status={status} label={CHAT.runStatus[status]} />
        ))}
      </GalleryItem>
      <GalleryItem name="Fence" column>
        <Fence label={CHAT.fenceLabel}>{CHAT.fence}</Fence>
      </GalleryItem>
      <GalleryItem name="Reasoning" column>
        <Reasoning label={CHAT.thinking}>{CHAT.thoughtBody}</Reasoning>
        <Reasoning label={CHAT.thought}>{CHAT.thoughtBody}</Reasoning>
      </GalleryItem>
      <GalleryItem name="ToolCard" column>
        {TOOL_DETAILS.map((detail) => (
          <ToolCard
            key={detail}
            name={CHAT.toolName}
            summary={CHAT.toolSummary}
            duration={CHAT.toolDuration}
            status="done"
            detail={detail}
            runningLabel={CHAT.running}
            failedLabel={CHAT.failed}
          >
            {CHAT.toolOutput}
          </ToolCard>
        ))}
        <ToolCard
          name={CHAT.toolName}
          summary={CHAT.toolSummary}
          status="running"
          detail="compact"
          runningLabel={CHAT.running}
          failedLabel={CHAT.failed}
        />
        <ToolCard
          name={CHAT.toolName}
          summary={CHAT.toolSummary}
          status="error"
          detail="expanded"
          runningLabel={CHAT.running}
          failedLabel={CHAT.failed}
        >
          {CHAT.toolError}
        </ToolCard>
      </GalleryItem>
      <GalleryItem name="ApprovalCard" column>
        <ApprovalCard
          level={3}
          title={CHAT.approvalTitle}
          detail={CHAT.approvalDetail}
          answers={["deny", "once"]}
          labels={CHAT.approvalLabels}
          onChoose={() => {}}
        />
        <ApprovalCard
          level={3}
          title={CHAT.approvalTitle}
          category={CHAT.approvalCategory}
          detail={CHAT.approvalDetail}
          taintLabel={CHAT.taint}
          context={CHAT.context}
          answers={["deny", "session", "always", "once"]}
          labels={CHAT.approvalLabels}
          onChoose={() => {}}
        />
      </GalleryItem>
    </>
  );
}

export function AiSection() {
  const t = useT();
  return (
    <GallerySection id="ai" title={t("gallery.section.ai")}>
      <Messages />
      <Runs />
      <ExtensionFigures />
    </GallerySection>
  );
}
