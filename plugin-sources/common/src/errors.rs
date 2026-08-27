use std::fmt::{Display, Formatter, Result};

#[derive(Debug)]
pub enum DatabaseError {
    Unknow(String, String),
    NotFound(String),
    ConnectionError(String),
    QueryError(String, String),
    DataError(String, String),
}
impl Display for DatabaseError {
    fn fmt(&self, f: &mut Formatter) -> Result {
        match self {
            DatabaseError::NotFound(item) => write!(f, "Not found: {}", item),
            DatabaseError::ConnectionError(why) => write!(f, "Connection error: {}", why),
            DatabaseError::QueryError(item, why) => write!(f, "Invalid query '{}': {}", item, why),
            DatabaseError::DataError(item, why) => write!(f, "Fail to get '{}': {}", item, why),
            DatabaseError::Unknow(item, why) => write!(f, "{}: {}", item, why),
        }
    }
}

impl std::error::Error for DatabaseError {}