use std::fmt::{Display, Formatter, Result};

#[derive(Debug)]
pub enum DatabaseError {
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
        }
    }
}

impl std::error::Error for DatabaseError {}