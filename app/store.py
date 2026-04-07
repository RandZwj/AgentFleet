from __future__ import annotations

from threading import Lock
from typing import Optional, Protocol, runtime_checkable

from app.models import ComparisonTaskRecord, CourseRecord, JobRecord, TaskRecord, TrainingAttemptRecord, now_iso


@runtime_checkable
class StoreProtocol(Protocol):
    """Store 接口协议，InMemoryStore 和 PostgresStore 都必须实现。"""

    def put_course(self, course: CourseRecord) -> None: ...
    def get_course(self, course_id: str) -> Optional[CourseRecord]: ...
    def update_course_content(self, course_id: str, content: dict) -> None: ...

    def put_task(self, task: TaskRecord) -> None: ...
    def get_task(self, task_id: str) -> Optional[TaskRecord]: ...
    def update_task(self, task_id: str, **kwargs) -> None: ...

    def put_training_attempt(self, attempt: TrainingAttemptRecord) -> None: ...
    def get_training_attempt(self, attempt_id: str) -> Optional[TrainingAttemptRecord]: ...

    def put_comparison_task(self, task: ComparisonTaskRecord) -> None: ...
    def get_comparison_task(self, comparison_task_id: str) -> Optional[ComparisonTaskRecord]: ...

    def put_job(self, job: JobRecord) -> None: ...
    def get_job(self, job_id: str) -> Optional[JobRecord]: ...
    def update_job(self, job_id: str, **kwargs) -> None: ...
    def list_jobs(self, status: Optional[str] = None, page: int = 1, page_size: int = 20) -> dict: ...


class InMemoryStore:
    def __init__(self) -> None:
        self._lock = Lock()
        self.courses: dict[str, CourseRecord] = {}
        self.tasks: dict[str, TaskRecord] = {}
        self.training_attempts: dict[str, TrainingAttemptRecord] = {}
        self.comparison_tasks: dict[str, ComparisonTaskRecord] = {}
        self.jobs: dict[str, JobRecord] = {}

    def put_course(self, course: CourseRecord) -> None:
        with self._lock:
            self.courses[course.course_id] = course

    def get_course(self, course_id: str) -> Optional[CourseRecord]:
        with self._lock:
            return self.courses.get(course_id)

    def update_course_content(self, course_id: str, content: dict) -> None:
        with self._lock:
            course = self.courses[course_id]
            course.content_version += 1
            course.latest_content = content
            course.updated_at = now_iso()
            self.courses[course_id] = course

    def put_task(self, task: TaskRecord) -> None:
        with self._lock:
            self.tasks[task.task_id] = task

    def get_task(self, task_id: str) -> Optional[TaskRecord]:
        with self._lock:
            return self.tasks.get(task_id)

    def update_task(self, task_id: str, **kwargs) -> None:
        with self._lock:
            task = self.tasks[task_id]
            task_data = task.model_dump()
            task_data.update(kwargs)
            task_data["updated_at"] = now_iso()
            self.tasks[task_id] = TaskRecord(**task_data)

    def put_training_attempt(self, attempt: TrainingAttemptRecord) -> None:
        with self._lock:
            self.training_attempts[attempt.attempt_id] = attempt

    def get_training_attempt(self, attempt_id: str) -> Optional[TrainingAttemptRecord]:
        with self._lock:
            return self.training_attempts.get(attempt_id)

    def put_comparison_task(self, task: ComparisonTaskRecord) -> None:
        with self._lock:
            self.comparison_tasks[task.comparison_task_id] = task

    def get_comparison_task(self, comparison_task_id: str) -> Optional[ComparisonTaskRecord]:
        with self._lock:
            return self.comparison_tasks.get(comparison_task_id)

    # ---- Job ----

    def put_job(self, job: JobRecord) -> None:
        with self._lock:
            self.jobs[job.job_id] = job

    def get_job(self, job_id: str) -> Optional[JobRecord]:
        with self._lock:
            return self.jobs.get(job_id)

    def update_job(self, job_id: str, **kwargs) -> None:
        with self._lock:
            job = self.jobs.get(job_id)
            if job is None:
                raise KeyError(f"job not found: {job_id}")
            job_data = job.model_dump()
            job_data.update(kwargs)
            job_data["updated_at"] = now_iso()
            self.jobs[job_id] = JobRecord(**job_data)

    def list_jobs(self, status: Optional[str] = None, page: int = 1, page_size: int = 20) -> dict:
        with self._lock:
            items = list(self.jobs.values())
            if status:
                items = [j for j in items if j.status == status]
            items.sort(key=lambda j: j.created_at, reverse=True)
            total = len(items)
            start = (page - 1) * page_size
            return {"jobs": items[start:start + page_size], "total": total}


def _create_store() -> StoreProtocol:
    """根据环境变量选择 Store 实现。"""
    from app.config import settings
    if settings.database_url_sync:
        from app.db.postgres_store import PostgresStore
        return PostgresStore(settings.database_url_sync)
    return InMemoryStore()


store: StoreProtocol = _create_store()
