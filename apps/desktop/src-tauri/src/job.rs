//! Windows Job Object：KILL_ON_JOB_CLOSE，外壳被强杀时所有后台一起结束。
//! 非 Windows 平台为空实现。

#[cfg(windows)]
mod imp {
    use std::io;
    use std::ptr;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// 全局 Job Object；句柄在应用生命周期内一直持有，不主动关。
    pub struct JobObject {
        handle: HANDLE,
    }

    // HANDLE 是 isize，所有权归本结构；访问仅在内部完成。
    unsafe impl Send for JobObject {}
    unsafe impl Sync for JobObject {}

    impl JobObject {
        pub fn create_kill_on_close() -> io::Result<Self> {
            unsafe {
                let handle = CreateJobObjectW(ptr::null(), ptr::null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    let err = io::Error::last_os_error();
                    CloseHandle(handle);
                    return Err(err);
                }
                Ok(Self { handle })
            }
        }

        /// 把 pid 对应的进程加入 Job；句柄用完即关。
        pub fn assign_process(&self, pid: u32) -> io::Result<()> {
            unsafe {
                let process =
                    OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let ok = AssignProcessToJobObject(self.handle, process);
                let err = if ok == 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                };
                CloseHandle(process);
                err
            }
        }
    }
}

#[cfg(windows)]
pub use imp::JobObject;
