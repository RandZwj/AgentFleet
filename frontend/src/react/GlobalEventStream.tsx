import { useEffect, useRef } from 'react';
import { EventBus } from '../shared/events/EventBus';

/**
 * 全局 SSE 事件订阅组件 — 监听后端广播的 Agent 活动事件，
 * 转发到 EventBus 驱动 Phaser 动画（走位、状态变更、气泡等）。
 *
 * 仅处理来源为 "job" 的事件，避免与 ChatBox 的 SSE 产生重复动画。
 */
export const GlobalEventStream: React.FC = () => {
  const esRef = useRef<EventSource | null>(null);
  const activeAgents = useRef<Set<string>>(new Set());

  useEffect(() => {
    const connect = () => {
      if (esRef.current) {
        esRef.current.close();
      }

      const es = new EventSource('/api/v1/office/events/stream');
      esRef.current = es;

      const handleEvent = (eventType: string, rawData: string) => {
        let d: any;
        try {
          d = JSON.parse(rawData);
        } catch {
          return;
        }

        if (d._source !== 'job') return;

        switch (eventType) {
          case 'routing':
          case 'process': {
            if (d.agent_slug) {
              activeAgents.current.add(d.agent_slug);
              EventBus.emit('agent:status', { agentSlug: d.agent_slug, status: 'working' });
            }
            if (d.movement) {
              EventBus.emit('chat:agent-move', {
                agentId: d.movement.agent_id,
                roomId: d.movement.room_id,
              });
            }
            if (d.agent_slug && d.content) {
              EventBus.emit('chat:agent-bubble', {
                agentSlug: d.agent_slug,
                text: d.content,
                duration: 10000,
              });
            }
            break;
          }

          case 'message': {
            if (d.agent_slug) {
              activeAgents.current.add(d.agent_slug);
              EventBus.emit('agent:status', { agentSlug: d.agent_slug, status: 'working' });
            }
            if (d.movement) {
              EventBus.emit('chat:agent-move', {
                agentId: d.movement.agent_id,
                roomId: d.movement.room_id,
              });
            }
            if (d.agent_slug && d.content) {
              EventBus.emit('chat:agent-bubble', {
                agentSlug: d.agent_slug,
                text: d.content?.slice(0, 60) + (d.content?.length > 60 ? '...' : ''),
                duration: 10000,
              });
            }
            if (d.usage && d.agent_slug) {
              EventBus.emit('agent:token-usage', {
                agentSlug: d.agent_slug,
                tokens: d.usage.total_tokens || 0,
              });
            }
            break;
          }

          case 'done': {
            for (const slug of activeAgents.current) {
              EventBus.emit('agent:status', { agentSlug: slug, status: 'idle' });
            }
            activeAgents.current.clear();
            break;
          }
        }
      };

      es.addEventListener('routing', (e) => handleEvent('routing', e.data));
      es.addEventListener('process', (e) => handleEvent('process', e.data));
      es.addEventListener('message', (e) => handleEvent('message', e.data));
      es.addEventListener('done', (e) => handleEvent('done', e.data));

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, []);

  return null;
};
