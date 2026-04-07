from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from app.db.engine import build_session_factory
from sqlalchemy import desc

from app.db.orm_models import (
    ComparisonTaskRow,
    CourseRow,
    JobRow,
    TaskRow,
    TrainingAttemptRow,
)
from app.models import (
    ComparisonTaskRecord,
    CourseRecord,
    JobRecord,
    TaskRecord,
    TrainingAttemptRecord,
    now_iso,
)


def _dt_to_iso(val) -> str:
    """将数据库返回的 datetime 转为 ISO 字符串，兼容已经是 str 的情况。"""
    if val is None:
        return now_iso()
    if isinstance(val, str):
        return val
    return val.isoformat()


class PostgresStore:
    """与 InMemoryStore 接口完全一致的 PostgreSQL 实现。"""

    def __init__(self, database_url: str) -> None:
        self.Session = build_session_factory(database_url)

    # ---- Course ----

    def put_course(self, course: CourseRecord) -> None:
        with self.Session() as session:
            row = CourseRow(
                course_id=course.course_id,
                product_id=course.product_id,
                product_name=course.product_name,
                objective=course.objective,
                required_points=course.required_points,
                product_facts=course.product_facts,
                content_version=course.content_version,
                latest_content=course.latest_content,
            )
            session.merge(row)
            session.commit()

    def get_course(self, course_id: str) -> Optional[CourseRecord]:
        with self.Session() as session:
            row = session.get(CourseRow, course_id)
            if row is None:
                return None
            return CourseRecord(
                course_id=row.course_id,
                product_id=row.product_id,
                product_name=row.product_name,
                objective=row.objective,
                required_points=row.required_points,
                product_facts=row.product_facts,
                content_version=row.content_version,
                latest_content=row.latest_content,
                created_at=_dt_to_iso(row.created_at),
                updated_at=_dt_to_iso(row.updated_at),
            )

    def update_course_content(self, course_id: str, content: dict) -> None:
        with self.Session() as session:
            row = session.get(CourseRow, course_id)
            if row is None:
                raise KeyError(f"course not found: {course_id}")
            row.content_version += 1
            row.latest_content = content
            session.commit()

    # ---- Task ----

    def put_task(self, task: TaskRecord) -> None:
        with self.Session() as session:
            row = TaskRow(
                task_id=task.task_id,
                trace_id=task.trace_id,
                task_type=task.task_type,
                status=task.status,
                input=task.input,
                output=task.output,
                error=task.error,
            )
            session.merge(row)
            session.commit()

    def get_task(self, task_id: str) -> Optional[TaskRecord]:
        with self.Session() as session:
            row = session.get(TaskRow, task_id)
            if row is None:
                return None
            return TaskRecord(
                task_id=row.task_id,
                trace_id=row.trace_id,
                task_type=row.task_type,
                status=row.status,
                input=getattr(row, "input"),
                output=row.output,
                error=row.error,
                created_at=_dt_to_iso(row.created_at),
                updated_at=_dt_to_iso(row.updated_at),
            )

    def update_task(self, task_id: str, **kwargs) -> None:
        with self.Session() as session:
            row = session.get(TaskRow, task_id)
            if row is None:
                raise KeyError(f"task not found: {task_id}")
            for key, value in kwargs.items():
                setattr(row, key, value)
            session.commit()

    # ---- TrainingAttempt ----

    def put_training_attempt(self, attempt: TrainingAttemptRecord) -> None:
        with self.Session() as session:
            row = TrainingAttemptRow(
                attempt_id=attempt.attempt_id,
                course_id=attempt.course_id,
                user_id=attempt.user_id,
                audio_url=attempt.audio_url,
                mock_transcript=attempt.mock_transcript,
            )
            session.merge(row)
            session.commit()

    def get_training_attempt(self, attempt_id: str) -> Optional[TrainingAttemptRecord]:
        with self.Session() as session:
            row = session.get(TrainingAttemptRow, attempt_id)
            if row is None:
                return None
            return TrainingAttemptRecord(
                attempt_id=row.attempt_id,
                course_id=row.course_id,
                user_id=row.user_id,
                audio_url=row.audio_url,
                mock_transcript=row.mock_transcript,
                created_at=_dt_to_iso(row.created_at),
            )

    # ---- ComparisonTask ----

    def put_comparison_task(self, task: ComparisonTaskRecord) -> None:
        with self.Session() as session:
            row = ComparisonTaskRow(
                comparison_task_id=task.comparison_task_id,
                source_product_id=task.source_product_id,
                source_product_name=task.source_product_name,
                targets=task.targets,
            )
            session.merge(row)
            session.commit()

    def get_comparison_task(self, comparison_task_id: str) -> Optional[ComparisonTaskRecord]:
        with self.Session() as session:
            row = session.get(ComparisonTaskRow, comparison_task_id)
            if row is None:
                return None
            return ComparisonTaskRecord(
                comparison_task_id=row.comparison_task_id,
                source_product_id=row.source_product_id,
                source_product_name=row.source_product_name,
                targets=row.targets,
                created_at=_dt_to_iso(row.created_at),
            )

    # ---- Job ----

    def put_job(self, job: JobRecord) -> None:
        with self.Session() as session:
            row = JobRow(
                job_id=job.job_id,
                status=job.status,
                task=job.task,
                context=job.context,
                agent_slug=job.agent_slug,
                callback_url=job.callback_url,
                priority=job.priority,
                timeout_seconds=job.timeout_seconds,
                dispatched_agents=job.dispatched_agents,
                result=job.result,
                summary=job.summary,
                messages=job.messages,
                error=job.error,
                usage=job.usage,
                duration_ms=job.duration_ms,
            )
            session.merge(row)
            session.commit()

    def get_job(self, job_id: str) -> Optional[JobRecord]:
        with self.Session() as session:
            row = session.get(JobRow, job_id)
            if row is None:
                return None
            return self._row_to_job(row)

    def update_job(self, job_id: str, **kwargs) -> None:
        with self.Session() as session:
            row = session.get(JobRow, job_id)
            if row is None:
                raise KeyError(f"job not found: {job_id}")
            for key, value in kwargs.items():
                setattr(row, key, value)
            session.commit()

    def list_jobs(self, status: Optional[str] = None, page: int = 1, page_size: int = 20) -> dict:
        with self.Session() as session:
            query = session.query(JobRow)
            if status:
                query = query.filter(JobRow.status == status)
            total = query.count()
            rows = (
                query.order_by(desc(JobRow.created_at))
                .offset((page - 1) * page_size)
                .limit(page_size)
                .all()
            )
            return {"jobs": [self._row_to_job(r) for r in rows], "total": total}

    @staticmethod
    def _row_to_job(row: JobRow) -> JobRecord:
        return JobRecord(
            job_id=row.job_id,
            status=row.status,
            task=row.task,
            context=row.context,
            agent_slug=row.agent_slug,
            callback_url=row.callback_url,
            priority=row.priority,
            timeout_seconds=row.timeout_seconds,
            dispatched_agents=row.dispatched_agents or [],
            result=row.result,
            summary=row.summary,
            messages=row.messages or [],
            error=row.error,
            usage=row.usage,
            duration_ms=row.duration_ms,
            created_at=_dt_to_iso(row.created_at),
            updated_at=_dt_to_iso(row.updated_at),
        )
